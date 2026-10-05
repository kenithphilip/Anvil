// documents/delivery_note_ingest no longer trusts an explicit order_id.
//
// It used to skip every check when the caller named an order, so a challan
// picked up on the wrong order landed there silently and satisfied that
// order's despatch check. It also wrote rows for an order_id from another
// tenant. Drives the real handler against an in-memory client; the despatch
// writer is replaced by a recorder so each test can see whether anything was
// written, and for which order.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables;
const writes = [];
const audits = [];

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      limit: () => b, order: () => b,
      maybeSingle: () => { single = true; return b; },
      then: (fn, rej) => Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(fn, rej),
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
  upsertDispatchLines: async (_svc, tenantId, rows, opts) => { writes.push({ tenantId, rows, opts }); return { inserted: rows.length, updated: 0 }; },
}));

const { default: ingest } = await import("../api/documents/delivery_note_ingest.js");

const run = async (body) => {
  const res = { setHeader() {}, _status: 0, _json: null };
  await ingest({ method: "POST", headers: {}, _body: body }, res);
  return res;
};

const challan = (over = {}) => ({
  classification: "delivery_note", delivery_note_no: "DC-0042", docket_no: "LR-7781",
  lines: [{ partNumber: "P-1", quantity: 2, line_ref: "1" }], ...over,
});

beforeEach(() => {
  tables = {
    orders: [
      { id: "ord-1", tenant_id: TENANT, po_number: "4500999999", customer_id: "c1" },
      { id: "ord-2", tenant_id: TENANT, po_number: "4500313249", customer_id: "c1" },
      { id: "ord-x", tenant_id: "other-tenant", po_number: "4500313249", customer_id: "cx" },
    ],
    invoices: [{ id: "inv-9", tenant_id: TENANT, order_id: "ord-2", invoice_number: "INV/26/0007" }],
  };
  writes.length = 0;
  audits.length = 0;
});

describe("explicit order_id is checked, not trusted", () => {
  it("refuses a challan whose PO names another order, offers that order, and writes nothing", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-1", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates).toEqual([{ id: "ord-2", po_number: "4500313249" }]);
    expect(writes).toHaveLength(0);
  });

  it("refuses a challan whose invoice is on another order", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-1", extracted: challan({ invoice_no: "inv/26/0007" }) });
    expect(res._json.ok).toBe(false);
    expect(res._json.reason).toBe("order_mismatch");
    expect(res._json.candidates.map((c) => c.id)).toEqual(["ord-2"]);
    expect(writes).toHaveLength(0);
  });

  it("returns 404 for an order of another tenant and writes nothing", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-x", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("records a challan whose PO matches the chosen order, and says how it was settled", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-2", extracted: challan({ buyer_po_no: " 4500313249 " }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.matched_on).toBe("order chosen by operator; PO number matches");
    expect(writes).toHaveLength(1);
    expect(writes[0].opts.orderId).toBe("ord-2");
    expect(writes[0].rows[0].order_id).toBe("ord-2");
    expect(writes[0].rows[0].lr_number).toBe("LR-7781");
  });

  it("records a challan with no checkable reference against the operator's choice, and the audit says so", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-1", extracted: challan() });
    expect(res._json.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].rows[0].order_id).toBe("ord-1");
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toContain("order chosen by operator; challan carries no checkable reference");
  });

  it("accepts an invoice number that is not on file (Tally invoices are not mirrored)", async () => {
    const res = await run({ document_id: "doc-1", order_id: "ord-1", extracted: challan({ invoice_no: "TALLY/9999" }) });
    expect(res._json.ok).toBe(true);
    expect(writes[0].rows[0].order_id).toBe("ord-1");
  });
});

describe("no order_id: the challan's own references still resolve it", () => {
  it("matches on the buyer PO and names the basis", async () => {
    const res = await run({ document_id: "doc-1", extracted: challan({ buyer_po_no: "4500313249" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.order_id).toBe("ord-2");
    expect(res._json.matched_on).toBe("matched_on_buyer_po_number");
    expect(writes[0].rows[0].order_id).toBe("ord-2");
  });

  it("falls back to the invoice number when the PO is absent", async () => {
    const res = await run({ document_id: "doc-1", extracted: challan({ invoice_no: "INV/26/0007" }) });
    expect(res._json.ok).toBe(true);
    expect(res._json.order_id).toBe("ord-2");
    expect(res._json.matched_on).toBe("matched_on_invoice_number");
  });

  it("refuses when nothing resolves, and writes nothing", async () => {
    const res = await run({ document_id: "doc-1", extracted: challan() });
    expect(res._json.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
