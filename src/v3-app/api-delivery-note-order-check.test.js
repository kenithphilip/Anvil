// documents/delivery_note_ingest: the challan must belong to the order it is
// recorded on, and a re-upload must update that challan, never move another
// order's despatch lines.
//
// Drives the real handler against an in-memory client that applies eq, in,
// ilike and like the way PostgREST does (including escaped % and _). The
// despatch writer is replaced by a recorder so each test sees exactly what
// would be written, for which order, under which key.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables;
let errors;
let upsertResult;
const writes = [];
const audits = [];

// PostgREST LIKE: % and _ are wildcards unless escaped with a backslash.
const likeToRegex = (pattern, flags) => {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
    else if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", flags);
};

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vals) => { rows = rows.filter((r) => vals.map(String).includes(String(r[c]))); return b; },
      ilike: (c, p) => { const re = likeToRegex(p, "i"); rows = rows.filter((r) => r[c] != null && re.test(String(r[c]))); return b; },
      like: (c, p) => { const re = likeToRegex(p, ""); rows = rows.filter((r) => r[c] != null && re.test(String(r[c]))); return b; },
      limit: () => b, order: () => b,
      maybeSingle: () => { single = true; return b; },
      then: (fn, rej) => {
        if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(fn, rej);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(fn, rej);
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

const { default: ingest } = await import("../api/documents/delivery_note_ingest.js");

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
    dispatch_lines: [],
  };
  errors = {};
  upsertResult = null;
  writes.length = 0;
  audits.length = 0;
});

describe("explicit order_id is checked against the challan's own references", () => {
  it("refuses a challan whose PO names another order, offers that order by PO, and writes nothing", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates).toEqual([{ id: "ord-2", po_number: "4500313249" }]);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the chosen order has no PO number but the challan's PO belongs to another order", async () => {
    const res = await run({ order_id: "ord-3", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates.map((c) => c.id)).toEqual(["ord-2"]);
    expect(writes).toHaveLength(0);
  });

  it("refuses a challan whose invoice is on another order, even when its PO matches the chosen order", async () => {
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249", invoice_no: "INV/26/0008" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates).toEqual([{ id: "ord-4", po_number: "4500777777" }]);
    expect(writes).toHaveLength(0);
  });

  it("returns 404 for an order of another tenant and writes nothing", async () => {
    const res = await run({ order_id: "ord-x", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("fails closed with 500 when the invoice read fails, and writes nothing", async () => {
    errors.invoices = { code: "57014", message: "statement timeout" };
    const res = await run({ order_id: "ord-1", extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(res._status).toBe(500);
    expect(writes).toHaveLength(0);
  });

  it("records a challan whose PO matches, and says what was checked", async () => {
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: " 4500313249 " }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toBe("order chosen by operator; PO number matches");
    expect(writes).toHaveLength(1);
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

  it("names an unknown PO honestly when the order has no PO number to compare", async () => {
    const res = await run({ order_id: "ord-3", extracted: challan({ buyer_po_no: "9999" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toContain("the challan's PO is on no order and the order has no PO number to compare");
  });

  it("accepts an invoice number that is not on file (Tally invoices are not mirrored), and says so", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ invoice_no: "TALLY/9999" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toContain("the challan's invoice number is not on file");
  });

  it("matches a PO containing % literally, not as a wildcard", async () => {
    tables.orders.push({ id: "ord-5", tenant_id: TENANT, po_number: "45%00", customer_id: "c1" });
    const res = await run({ order_id: "ord-1", extracted: challan({ buyer_po_no: "45%00" }) });
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates.map((c) => c.id)).toEqual(["ord-5"]);
  });
});

describe("a challan is one identity, keyed by number and date", () => {
  it("refuses to record a challan already recorded on another order, instead of moving its lines", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2026-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("challan_recorded_on_other_order");
    expect(res._json.candidates).toEqual([{ id: "ord-1", po_number: "4500999999" }]);
    expect(writes).toHaveLength(0);
  });

  it("re-records the same challan on the same order (an update, not a refusal)", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-2", source_ref: "DC-0042@2026-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].source_ref).toBe("DC-0042@2026-10-01#0");
  });

  it("treats the same number on a different date (a new financial year) as a different challan", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", source_ref: "DC-0042@2025-10-01#0" }];
    const res = await run({ order_id: "ord-2", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].source_ref).toBe("DC-0042@2026-10-01#0");
  });

  it("keys an unnumbered challan by its stored document, so a re-upload updates rather than duplicates", async () => {
    const res = await run({ order_id: "ord-1", extracted: challan({ delivery_note_no: null }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].source_ref).toBe("doc:doc-1#0");
  });

  it("refuses a challan with neither a number nor a stored document", async () => {
    const res = await run({ order_id: "ord-1", document_id: null, extracted: challan({ delivery_note_no: null }) });
    expect(res._json.ok).toBe(false);
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
  it("returns ok:false write_failed when the writer reports errors", async () => {
    upsertResult = { inserted: 0, updated: 0, errors: [{ index: 0, source_ref: "x", message: "invalid input syntax for type date" }] };
    const res = await run({ order_id: "ord-1", extracted: challan() });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("write_failed");
    expect(res._json.detail).toContain("invalid input syntax for type date");
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
    expect(res._json.ok).toBe(true);
    expect(res._json.order_id).toBe("ord-2");
    expect(res._json.matched_on).toBe("matched_on_invoice_number");
  });

  it("refuses a challan whose PO and invoice point to different orders", async () => {
    const res = await run({ extracted: challan({ buyer_po_no: "4500313249", invoice_no: "INV/26/0008" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("conflicting_references");
    expect(res._json.candidates.map((c) => c.id).sort()).toEqual(["ord-2", "ord-4"]);
    expect(writes).toHaveLength(0);
  });

  it("refuses an invoice number carried by two orders, and offers both", async () => {
    tables.invoices.push({ id: "inv-7", tenant_id: TENANT, order_id: "ord-1", invoice_number: "INV/26/0007" });
    const res = await run({ extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("ambiguous_invoice_number");
    expect(res._json.candidates.map((c) => c.id).sort()).toEqual(["ord-1", "ord-2"]);
  });

  it("refuses when nothing resolves, and writes nothing", async () => {
    const res = await run({ extracted: challan() });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("unresolved_order");
    expect(writes).toHaveLength(0);
  });
});
