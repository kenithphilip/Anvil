// documents/delivery_note_ingest: the challan must belong to the order it is
// recorded on, and a re-upload must replace that challan, never move another
// order's despatch lines or count the same goods twice.
//
// Drives the real handler against an in-memory client that applies eq, in,
// ilike, like (with backslash escapes) and limit the way PostgREST does, and
// supports delete. The despatch writer is replaced by a recorder so each test
// sees exactly what would be written, for which order, under which key.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables;
let errors;
let upsertResult;
const writes = [];
const audits = [];
const deletes = [];

const likeToRegex = (pattern, flags) => {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
    else if (ch === "%" || ch === "*") re += ".*";   // PostgREST reads * as %
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", flags);
};

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    let single = false;
    let lim = Infinity;
    let mode = "select";
    const b = {
      select: () => b,
      delete: () => { mode = "delete"; return b; },
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vals) => { rows = rows.filter((r) => vals.map(String).includes(String(r[c]))); return b; },
      ilike: (c, p) => { const re = likeToRegex(p, "i"); rows = rows.filter((r) => r[c] != null && re.test(String(r[c]))); return b; },
      like: (c, p) => { const re = likeToRegex(p, ""); rows = rows.filter((r) => r[c] != null && re.test(String(r[c]))); return b; },
      limit: (n) => { lim = n; return b; },
      order: () => b,
      maybeSingle: () => { single = true; return b; },
      then: (fn, rej) => {
        if (errors[table] && mode === "select") return Promise.resolve({ data: null, error: errors[table] }).then(fn, rej);
        if (mode === "delete") {
          const ids = new Set(rows.map((r) => r.id));
          deletes.push(...rows.map((r) => r.id));
          tables[table] = (tables[table] || []).filter((r) => !ids.has(r.id));
          return Promise.resolve({ data: null, error: null }).then(fn, rej);
        }
        const out = rows.slice(0, lim);
        return Promise.resolve({ data: single ? out[0] || null : out, error: null }).then(fn, rej);
      },
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message, status: err.status || 500 } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "staff1" }, role: "sales_engineer" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async (_ctx, p) => { audits.push(p); } }));
vi.mock("../api/_lib/dispatch-lines.js", () => ({
  upsertDispatchLines: async (_svc, tenantId, rows, opts) => {
    writes.push({ tenantId, rows, opts });
    return upsertResult || { inserted: rows.length, updated: 0, errors: [] };
  },
}));

const { default: ingest, challanDate } = await import("../api/documents/delivery_note_ingest.js");

const run = async (body) => {
  const res = { setHeader() {}, _status: 0, _json: null };
  await ingest({ method: "POST", headers: {}, _body: { document_id: "doc-1", ...body } }, res);
  return res;
};

const challan = (over = {}) => ({
  classification: "delivery_note", delivery_note_no: "DC-0042", delivery_note_date: "2026-10-01", docket_no: "LR-7781",
  lines: [{ partNumber: "P-1", quantity: 2, line_ref: "1" }], ...over,
});

beforeEach(() => {
  tables = {
    orders: [
      { id: "ord-1", tenant_id: TENANT, po_number: "4500999999", customer_id: "c1" },
      { id: "ord-2", tenant_id: TENANT, po_number: "4500313249", customer_id: "c1" },
      { id: "ord-3", tenant_id: TENANT, po_number: null, customer_id: "c1" },
      { id: "ord-4", tenant_id: TENANT, po_number: "4500777777", customer_id: "c1" },
      { id: "ord-x", tenant_id: "other-tenant", po_number: "4500313249", customer_id: "cx" },
    ],
    invoices: [
      { id: "inv-9", tenant_id: TENANT, order_id: "ord-2", invoice_number: "INV/26/0007" },
      { id: "inv-8", tenant_id: TENANT, order_id: "ord-4", invoice_number: "INV/26/0008" },
    ],
    einvoices: [
      { id: "ein-5", tenant_id: TENANT, order_id: "ord-4", invoice_number: "OBR/25-26/0005" },
    ],
    dispatch_lines: [],
  };
  errors = {};
  upsertResult = null;
  writes.length = 0;
  audits.length = 0;
  deletes.length = 0;
});

describe("challanDate reads printed dates day-first, and refuses to guess", () => {
  it("normalises the common Indian renderings to ISO", () => {
    expect(challanDate("2026-10-01")).toBe("2026-10-01");
    expect(challanDate("01/10/2026")).toBe("2026-10-01");
    expect(challanDate("1-10-26")).toBe("2026-10-01");
    expect(challanDate("01.10.2026")).toBe("2026-10-01");
    expect(challanDate("1-Oct-2026")).toBe("2026-10-01");
    expect(challanDate("13/10/2026")).toBe("2026-10-13");
  });
  it("returns null for what it cannot read, rather than a wrong date", () => {
    expect(challanDate("31/02/2026")).toBeNull();
    expect(challanDate("next tuesday")).toBeNull();
    expect(challanDate(null)).toBeNull();
  });
});

describe("explicit order_id is checked against the challan's own references", () => {
  it("refuses a challan whose PO names another order, offers that order by PO, and writes nothing", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates).toEqual([{ id: "ord-2", po_number: "4500313249" }]);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the chosen order has no PO number but the challan's PO belongs to another order", async () => {
    const res = await run({ order_id: "ord-3", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates.map((c) => c.id)).toEqual(["ord-2"]);
    expect(writes).toHaveLength(0);
  });

  it("refuses a challan whose invoice is on another order, even when its PO matches the chosen order", async () => {
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249", invoice_no: "INV/26/0008" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates).toEqual([{ id: "ord-4", po_number: "4500777777" }]);
    expect(writes).toHaveLength(0);
  });

  it("reads GST e-invoices too: an e-invoice on another order is a mismatch, not 'not on file'", async () => {
    const res = await run({ order_id: "ord-3", extracted: challan({ invoice_no: "obr/25-26/0005" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates.map((c) => c.id)).toEqual(["ord-4"]);
    expect(writes).toHaveLength(0);
  });

  it("matches invoice numbers exactly, never as a substring", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ invoice_no: "0007" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toContain("the challan's invoice number is not on file");
  });

  it("refuses to decide when a lookup returns a full page of exact matches", async () => {
    for (let i = 0; i < 200; i += 1) tables.invoices.push({ id: "dup-" + i, tenant_id: TENANT, order_id: "ord-" + (100 + i), invoice_number: "17" });
    const res = await run({ order_id: "ord-1", extracted: challan({ invoice_no: "17" }) });
    expect(res._status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("returns 404 for an order of another tenant and writes nothing", async () => {
    const res = await run({ order_id: "ord-x", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("fails closed with 500 when a reference read fails, and writes nothing", async () => {
    errors.invoices = { code: "57014", message: "statement timeout" };
    const r1 = await run({ order_id: "ord-1", extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(r1._status).toBe(500);
    errors = { orders: { code: "57014", message: "statement timeout" } };
    const r2 = await run({ order_id: "ord-1", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(r2._status).toBe(500);
    expect(writes).toHaveLength(0);
  });

  it("records a challan whose PO matches, including a differently printed PO, and says what was checked", async () => {
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "PO 4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toBe("order chosen by operator; PO number matches");
    expect(writes[0].opts.orderId).toBe("ord-2");
    expect(writes[0].rows[0].order_id).toBe("ord-2");
    expect(writes[0].rows[0].lr_number).toBe("LR-7781");
  });

  it("records the invoice-matched basis when only the invoice is cited", async () => {
    const res = await run({ order_id: "ord-2", extracted: challan({ invoice_no: "inv/26/0007" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toBe("order chosen by operator; invoice number matches");
  });

  it("records a challan with no checkable reference against the operator's choice, and the audit says so", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan() });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].order_id).toBe("ord-1");
    expect(audits[0].detail).toContain("order chosen by operator; challan carries no checkable reference");
  });

  it("holds a challan whose PO is on no order and differs from this order's, until the operator confirms", async () => {
    const held = await run({ order_id: "ord-1", extracted: challan({ buyer_po_no: "PO-778" }) });
    expect(held._json.ok).toBe(false);
    expect(held._json.reason).toBe("po_differs");
    expect(held._json.overridable).toBe(true);
    expect(writes).toHaveLength(0);
    const confirmed = await run({ order_id: "ord-1", confirm_po_mismatch: true, extracted: challan({ buyer_po_no: "PO-778" }) });
    expect(confirmed._json.ok).toBe(true);
    expect(confirmed._json.matched_on).toContain("operator confirmed");
    expect(writes[0].rows[0].order_id).toBe("ord-1");
  });

  it("does not let the confirmation override a PO that belongs to another order", async () => {
    const res = await run({ order_id: "ord-1", confirm_po_mismatch: true, extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(writes).toHaveLength(0);
  });

  it("names an unknown PO honestly when the order has no PO number to compare", async () => {
    const res = await run({ order_id: "ord-3", extracted: challan({ buyer_po_no: "9999" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toContain("the challan's PO is on no order and the order has no PO number to compare");
  });
});

describe("a challan is one identity: its number within a financial year", () => {
  it("stores the challan date as ISO, read day-first", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ delivery_note_date: "13/10/2026" }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].dispatch_date).toBe("2026-10-13");
    expect(writes[0].rows[0].source_ref).toBe("DC-0042@2026-10-13#0");
  });

  it("refuses to record a challan already recorded on another order, instead of moving its lines", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2026-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.reason).toBe("challan_recorded_on_other_order");
    expect(res._json.candidates).toEqual([{ id: "ord-1", po_number: "4500999999" }]);
    expect(writes).toHaveLength(0);
  });

  it("treats a differently printed date in the same financial year as the same challan", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@undated#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249", delivery_note_date: "01/10/2026" }) });
    expect(res._json.reason).toBe("challan_recorded_on_other_order");
  });

  it("treats the same number in a different financial year as a different challan", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2025-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].source_ref).toBe("DC-0042@2026-10-01#0");
  });

  it("counts a despatch row with no order as elsewhere, rather than adopting it", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: TENANT, order_id: null, source_ref: "DC-0042@2026-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.reason).toBe("challan_recorded_on_other_order");
    expect(writes).toHaveLength(0);
  });

  it("ignores another tenant's row with the same key", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: "other-tenant", order_id: "ord-x", source_ref: "DC-0042@2026-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
  });

  it("fails closed when the earlier-records read fails", async () => {
    errors.dispatch_lines = { code: "57014", message: "statement timeout" };
    const res = await run({ order_id: "ord-1", extracted: challan() });
    expect(res._status).toBe(500);
    expect(writes).toHaveLength(0);
  });

  it("replaces the challan on re-upload: lines the new read did not produce are removed", async () => {
    tables.dispatch_lines = [
      { id: "dl-0", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2026-10-01#0" },
      { id: "dl-1", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2026-10-01#1" },
      { id: "dl-2", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@undated#0" },
      { id: "dl-9", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-9999@2026-10-01#0" },
    ];
    const res = await run({ order_id: "ord-1", extracted: challan() });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows.map((r) => r.source_ref)).toEqual(["DC-0042@2026-10-01#0"]);
    expect(deletes.sort()).toEqual(["dl-1", "dl-2"]);
    expect(res._json.written.removed).toBe(2);
  });

  it("removes nothing when the write failed", async () => {
    tables.dispatch_lines = [{ id: "dl-1", tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2026-10-01#1" }];
    upsertResult = { inserted: 0, updated: 0, errors: [{ index: 0, source_ref: "x", message: "invalid input syntax for type date" }] };
    const res = await run({ order_id: "ord-1", extracted: challan() });
    expect(res._json.reason).toBe("write_failed");
    expect(deletes).toEqual([]);
  });

  it("keys an unnumbered challan by its stored document", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ delivery_note_no: null }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].source_ref).toBe("DOC:doc-1@2026-10-01#0");
  });

  it("refuses a challan with neither a number nor a stored document", async () => {
    const res = await run({ order_id: "ord-1", document_id: null, extracted: challan({ delivery_note_no: null }) });
    expect(res._json.reason).toBe("no_challan_identity");
    expect(writes).toHaveLength(0);
  });

  it("gives every line its own key, even when line refs are not ordinals and parts are missing", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ lines: [
      { quantity: 1, line_ref: "A/1" }, { quantity: 4, line_ref: "A/2" },
    ] }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows.map((r) => r.source_ref)).toEqual(["DC-0042@2026-10-01#0", "DC-0042@2026-10-01#1"]);
  });
});

describe("a write that failed is not reported as recorded", () => {
  it("returns ok:false write_failed with what did land", async () => {
    upsertResult = { inserted: 1, updated: 0, errors: [{ index: 1, source_ref: "x", message: "invalid input syntax for type date" }] };
    const res = await run({ order_id: "ord-1", extracted: challan({ lines: [{ quantity: 1 }, { quantity: 2 }] }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("write_failed");
    expect(res._json.written.inserted).toBe(1);
    expect(audits[0].detail).toContain("1 failed");
  });
});

describe("no order_id: the challan's own references resolve it, or it is refused", () => {
  it("matches on the buyer PO and names the basis", async () => {
    const res = await run({ extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.order_id).toBe("ord-2");
    expect(res._json.matched_on).toBe("matched_on_buyer_po_number");
  });

  it("falls back to the invoice number when the PO is absent", async () => {
    const res = await run({ extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(res._json.order_id).toBe("ord-2");
    expect(res._json.matched_on).toBe("matched_on_invoice_number");
  });

  it("refuses a challan whose PO and invoice point to different orders", async () => {
    const res = await run({ extracted: challan({ buyer_po_no: "4500313249", invoice_no: "INV/26/0008" }) });
    expect(res._json.reason).toBe("conflicting_references");
    expect(res._json.candidates.map((c) => c.id).sort()).toEqual(["ord-2", "ord-4"]);
    expect(writes).toHaveLength(0);
  });

  it("refuses an invoice number carried by two orders, and offers both", async () => {
    tables.invoices.push({ id: "inv-7", tenant_id: TENANT, order_id: "ord-1", invoice_number: "INV/26/0007" });
    const res = await run({ extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(res._json.reason).toBe("ambiguous_invoice_number");
    expect(res._json.candidates.map((c) => c.id).sort()).toEqual(["ord-1", "ord-2"]);
  });

  it("refuses when nothing resolves, and writes nothing", async () => {
    const res = await run({ extracted: challan() });
    expect(res._json.reason).toBe("unresolved_order");
    expect(writes).toHaveLength(0);
  });
});
