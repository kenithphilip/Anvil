// Handler test for src/api/quotes/index.js POST — the opportunity →
// quote line carry-through. When a quote is created from an opportunity
// with no lines supplied, opportunity_line_items copy into the quote.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ oli: [], inserted: null }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: (table) => {
      const b = {
        _table: table, _op: "select", _count: false, _payload: null,
        select(_c, opts) { if (opts?.head) this._count = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        eq() { return this; },
        like() { return this; },
        order() { return Promise.resolve({ data: h.oli, error: null }); },
        maybeSingle() {
          if (this._table === "opportunities") return Promise.resolve({ data: { related_lead_id: null }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          if (this._op === "insert") { h.inserted = this._payload; return Promise.resolve({ data: { id: "q-1", ...this._payload }, error: null }); }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          if (this._table === "quotes" && this._count) return resolve({ count: 0, error: null });
          return resolve({ data: null, error: null });
        },
      };
      return b;
    },
  }),
}));

const { default: handler } = await import("../api/quotes/index.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  send(p) { this.body = p; return this; },
  end() { return this; },
});

const post = async (body) => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, query: {}, body }, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = res.body; }
  return { res, parsed };
};

beforeEach(() => {
  h.oli = [
    { line_index: 0, product_family: "Gun", product_category: "x2c", part_no: "GUN-1", description: null, qty: 3, uom: "Nos", expected_unit_price: 1000 },
    { line_index: 1, product_family: "Spare", product_category: null, part_no: null, description: "O-ring", qty: 10, uom: "pcs", expected_unit_price: 50 },
  ];
  h.inserted = null;
});

describe("POST /api/quotes — opportunity line carry-through", () => {
  it("copies opportunity_line_items into the quote when no lines supplied", async () => {
    const { res } = await post({ customer_id: "c-1", opportunity_id: "opp-1", currency: "INR", validity_days: 30 });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.line_items).toHaveLength(2);
    expect(h.inserted.line_items[0]).toMatchObject({ partNumber: "GUN-1", description: "Gun / x2c", quantity: 3, uom: "Nos", unitPrice: 1000 });
    expect(h.inserted.line_items[1]).toMatchObject({ partNumber: null, description: "O-ring", quantity: 10, unitPrice: 50 });
    // totals computed from the copied lines (3*1000 + 10*50)
    expect(h.inserted.subtotal).toBe(3500);
    expect(h.inserted.grand_total).toBe(3500);
    // provenance recorded
    expect(h.inserted.field_sources.line_items).toBe("opportunity.line_items");
  });

  it("does NOT overwrite caller-supplied lines", async () => {
    const { res } = await post({
      customer_id: "c-1", opportunity_id: "opp-1", currency: "INR", validity_days: 30,
      line_items: [{ partNumber: "MANUAL", quantity: 1, unitPrice: 9 }],
    });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.line_items).toHaveLength(1);
    expect(h.inserted.line_items[0].partNumber).toBe("MANUAL");
    expect(h.inserted.field_sources.line_items).toBeUndefined();
  });

  it("leaves lines empty when the opportunity has none", async () => {
    h.oli = [];
    const { res } = await post({ customer_id: "c-1", opportunity_id: "opp-1", currency: "INR", validity_days: 30 });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.line_items).toHaveLength(0);
  });
});
