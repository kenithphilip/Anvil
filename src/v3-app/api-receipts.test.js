// /api/receipts: capture a customer GRN/SRN and auto-match it to an invoice
// (by invoice_number) and an order (by po_number). In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rows = () => H.store[table];
      const q = {
        _op: "select", _f: [], _payload: null, _sel: false,
        select() { this._sel = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        order() { return this; },
        limit() { return this; },
        _match(r) { return this._f.every((fn) => fn(r)); },
        _exec(single) {
          const store = rows();
          if (this._op === "insert") {
            const rec = { id: this._payload.id || "id-" + (++H.seq), ...this._payload };
            store.push(rec);
            return Promise.resolve({ data: this._sel ? (single ? rec : [rec]) : null, error: null });
          }
          if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); return Promise.resolve({ data: null, error: null }); }
          const hit = store.filter((r) => this._match(r));
          return Promise.resolve({ data: single ? (hit[0] || null) : hit, error: null });
        },
        single() { const s = this; return { then: (r, j) => s._exec(1).then(r, j) }; },
        maybeSingle() { const s = this; return { then: (r, j) => s._exec(1).then(r, j) }; },
        then(r, j) { return this._exec(0).then(r, j); },
      };
      return q;
    },
  }),
}));

const { default: receipts } = await import("../api/receipts/index.js");
const run = async ({ method = "GET", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await receipts({ method, headers: {}, url: "/api/receipts", query, body: body || {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    invoices: [{ id: "inv-1", tenant_id: "t-1", invoice_number: "INV-42", order_id: "ord-1", customer_id: "cust-1" }],
    orders: [{ id: "ord-9", tenant_id: "t-1", po_number: "PO-7777", customer_id: "cust-9" }],
    customer_receipts: [{ id: "r-old", tenant_id: "t-1", invoice_id: "inv-1", status: "matched" }],
  };
});

describe("receipts endpoint", () => {
  it("lists this tenant's receipts, filterable by invoice", async () => {
    const out = await run({ method: "GET", query: { invoice_id: "inv-1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.receipts.map((r) => r.id)).toEqual(["r-old"]);
  });

  it("auto-matches a GRN to an invoice by invoice_number (inherits order+customer)", async () => {
    const out = await run({ method: "POST", body: { receipt_type: "GRN", receipt_number: "GRN-1", receipt_date: "2026-07-20", invoice_number: "INV-42" } });
    expect(out.statusCode).toBe(200);
    const r = out.body.receipt;
    expect(r.invoice_id).toBe("inv-1");
    expect(r.order_id).toBe("ord-1");
    expect(r.customer_id).toBe("cust-1");
    expect(r.status).toBe("matched");
    expect(r.created_by).toBe("u-1");
  });

  it("auto-matches to an order by po_number when no invoice", async () => {
    const out = await run({ method: "POST", body: { receipt_number: "GRN-2", po_number: "PO-7777" } });
    const r = out.body.receipt;
    expect(r.order_id).toBe("ord-9");
    expect(r.customer_id).toBe("cust-9");
    expect(r.status).toBe("matched");
  });

  it("captures unmatched (no invoice/po hit) as 'captured'", async () => {
    const out = await run({ method: "POST", body: { receipt_number: "GRN-3", invoice_number: "INV-NOPE" } });
    expect(out.body.receipt.status).toBe("captured");
    expect(out.body.receipt.invoice_id).toBeNull();
  });

  it("rejects a caller-supplied FK id that isn't this tenant's (no cross-tenant link)", async () => {
    const out = await run({ method: "POST", body: { receipt_number: "GRN-X", invoice_id: "foreign-999" } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error.message).toMatch(/invoice_id not found/);
  });

  it("accepts an owned FK id", async () => {
    const out = await run({ method: "POST", body: { receipt_number: "GRN-Y", invoice_id: "inv-1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.receipt.invoice_id).toBe("inv-1");
  });

  it("normalizes a day-first receipt_date and 400s an unparseable one", async () => {
    const ok = await run({ method: "POST", body: { receipt_number: "GRN-D", receipt_date: "19/07/2026" } });
    expect(ok.body.receipt.receipt_date).toBe("2026-07-19");
    const bad = await run({ method: "POST", body: { receipt_number: "GRN-B", receipt_date: "sometime last week" } });
    expect(bad.statusCode).toBe(400);
  });

  it("deletes a receipt (tenant-scoped)", async () => {
    const out = await run({ method: "DELETE", query: { id: "r-old" } });
    expect(out.statusCode).toBe(200);
    expect(H.store.customer_receipts.find((r) => r.id === "r-old")).toBeUndefined();
  });
});
