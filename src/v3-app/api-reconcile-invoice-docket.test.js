// The invoice check must see the docket a recorded challan carries.
//
// orders/reconcile_invoice read dispatch_lines without lr_number, so the docket
// was always null and every invoice reported "no docket" even after a challan
// was recorded. The existing tests passed whole rows, which hid it. This
// stand-in returns ONLY the selected columns, as PostgREST does.
//
// It also checks the docket belongs to THIS invoice: another invoice's
// consignment does not prove this one can move.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables;

const project = (row, cols) => {
  if (!cols || cols.trim() === "*") return row;
  const names = cols.split(",").map((c) => c.trim()).filter(Boolean);
  return Object.fromEntries(names.filter((c) => c in row).map((c) => [c, row[c]]));
};

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    let cols = "*";
    let single = false;
    const b = {
      select: (c) => { cols = c || "*"; return b; },
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vals) => { rows = rows.filter((r) => vals.map(String).includes(String(r[c]))); return b; },
      order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      then: (fn, rej) => {
        const data = rows.map((r) => project(r, cols));
        return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(fn, rej);
      },
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "staff1" }, role: "sales_engineer" }),
  requirePermission: () => {},
}));

const { default: reconcileInvoice } = await import("../api/orders/reconcile_invoice.js");

const run = async (body) => {
  const res = { setHeader() {}, _status: 0, _json: null };
  await reconcileInvoice({ method: "POST", headers: {}, _body: body }, res);
  return res;
};

const invoice = (id, number) => ({
  id, tenant_id: TENANT, order_id: "ord-1", invoice_number: number, status: "draft",
  line_items: [{ part_no: "P-1", qty: 2, rate: 100 }], grand_total: 236, currency: "INR",
  customer_po_number: "4500313249", created_at: "2026-10-0" + (id === "inv-1" ? "1" : "2"),
});

beforeEach(() => {
  tables = {
    orders: [{ id: "ord-1", tenant_id: TENANT, customer_id: "c1", po_number: "4500313249", result: { salesOrder: { lineItems: [{ part_no: "P-1", qty: 2, rate: 100 }] } } }],
    invoices: [invoice("inv-1", "INV/26/0001")],
    dispatch_lines: [],
    tenant_settings: [], customers: [], eway_bills: [],
  };
});

const docketOf = (res) => res._json.dispatch_readiness.docket;
const verdicts = (res) => res._json.dispatch_readiness.findings.map((f) => f.verdict);

describe("reconcile_invoice reads the docket a challan recorded", () => {
  it("reports no docket when nothing was despatched", async () => {
    const res = await run({ order_id: "ord-1", invoice_id: "inv-1" });
    expect(res._status).toBe(200);
    expect(docketOf(res)).toBeNull();
    expect(verdicts(res)).toContain("docket_missing");
  });

  it("finds the docket on a despatch row billed on this invoice", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 2, lr_number: "LR-7781", invoice_number: "inv/26/0001" }];
    const res = await run({ order_id: "ord-1", invoice_id: "inv-1" });
    expect(docketOf(res)).toBe("LR-7781");
    expect(verdicts(res)).not.toContain("docket_missing");
  });

  it("uses the order-level docket only when no despatch row carries an invoice number", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 2, lr_number: "LR-1000", invoice_number: null }];
    const res = await run({ order_id: "ord-1", invoice_id: "inv-1" });
    expect(docketOf(res)).toBe("LR-1000");
  });

  it("accepts a docket billed on an invoice number Anvil does not hold (a Tally-raised number)", async () => {
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 2, lr_number: "LR-5555", invoice_number: "TALLY/25-26/0099" }];
    const res = await run({ order_id: "ord-1", invoice_id: "inv-1" });
    expect(docketOf(res)).toBe("LR-5555");
    expect(verdicts(res)).not.toContain("docket_missing");
  });

  it("prefers the docket billed on this invoice over an unattributed one", async () => {
    tables.dispatch_lines = [
      { tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 1, lr_number: "LR-OTHER", invoice_number: null },
      { tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 1, lr_number: "LR-MINE", invoice_number: "INV/26/0001" },
    ];
    const res = await run({ order_id: "ord-1", invoice_id: "inv-1" });
    expect(docketOf(res)).toBe("LR-MINE");
  });

  it("does not let another invoice's consignment satisfy this invoice's docket", async () => {
    tables.invoices = [invoice("inv-1", "INV/26/0001"), invoice("inv-2", "INV/26/0002")];
    tables.dispatch_lines = [{ tenant_id: TENANT, order_id: "ord-1", part_no: "P-1", dispatched_qty: 2, lr_number: "LR-7781", invoice_number: "INV/26/0001" }];
    const res = await run({ order_id: "ord-1", invoice_id: "inv-2" });
    expect(docketOf(res)).toBeNull();
    expect(verdicts(res)).toContain("docket_missing");
  });
});
