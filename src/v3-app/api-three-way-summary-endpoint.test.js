// GET /api/orders/three_way_summary — endpoint-level tests over a Supabase fake.
//
// Locks the multi-tenancy + extract-selection fixes:
//  - order_documents has no tenant_id, so the summary must be scoped THROUGH
//    the tenant's own orders (a busy tenant must not crowd another out).
//  - the newest USABLE extract per document wins (an empty_lines re-run must
//    not shadow an older good read).
//  - an order's attachments are searched for a usable extract, not just the
//    first one.
//  - the dual-code map is keyed with the same normalizer the report reads with
//    (partKey), so a lowercase-stored customer part still decides "our part".

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {} }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const rows = () => H.store[table] || [];
      const flt = [];
      let ord = null;
      let lim = null;
      const b = {
        select() { return b; },
        eq(c, v) { flt.push((r) => r[c] === v); return b; },
        in(c, arr) { const s = new Set(arr); flt.push((r) => s.has(r[c])); return b; },
        is(c, v) { flt.push((r) => (r[c] ?? null) === v); return b; },
        order(c, opts) { ord = { c, asc: opts?.ascending !== false, nullsFirst: !!opts?.nullsFirst }; return b; },
        limit(n) { lim = n; return b; },
        then(resolve) {
          let data = rows().filter((r) => flt.every((f) => f(r)));
          if (ord) {
            data = [...data].sort((x, y) => {
              const xv = x[ord.c]; const yv = y[ord.c];
              const xn = xv == null; const yn = yv == null;
              if (xn || yn) return xn && yn ? 0 : xn ? (ord.nullsFirst ? -1 : 1) : (ord.nullsFirst ? 1 : -1);
              if (xv < yv) return ord.asc ? -1 : 1;
              if (xv > yv) return ord.asc ? 1 : -1;
              return 0;
            });
          }
          if (lim != null) data = data.slice(0, lim);
          resolve({ data, error: null });
        },
      };
      return b;
    },
  }),
}));

const { default: handler } = await import("../api/orders/three_way_summary.js");

const run = async (query = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/orders/three_way_summary", query }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

const goodLine = () => ({ customer_part_number: "ABC-123", part_no: "OURPART", quantity: 5, rate: 100, _match: { po_qty: 5, po_rate: 100 } });
const goodExtract = () => ({ lines: [{ customer_part_number: "ABC-123", part_no: "OURPART", quantity: 5, rate: 100 }], payment_terms: "Net 60" });
const orderRow = (id, extra = {}) => ({ id, tenant_id: "t-1", customer_id: "c-1", po_number: "PO-" + id, created_at: "2026-07-1" + id + "T00:00:00Z", payment_terms: "Net 60", result: { salesOrder: { lineItems: [goodLine()], payment_terms: "Net 60", customer: { payment_terms: "Net 60" } } }, ...extra });

beforeEach(() => { H.store = {}; });

describe("three_way_summary endpoint", () => {
  it("scopes through the tenant's orders — another tenant's attachments can't crowd it out", () => {
    // t-2 has MANY attached orders (would fill a cross-tenant window); t-1 has one.
    const t2 = Array.from({ length: 120 }, (_v, i) => ({ id: "z" + i, tenant_id: "t-2", customer_id: "c-2", created_at: "2026-07-20T00:00:00Z", result: {} }));
    H.store.orders = [orderRow("1"), ...t2];
    H.store.order_documents = [
      { order_id: "1", document_id: "d1", role: "sales_order" },
      ...t2.map((o) => ({ order_id: o.id, document_id: "zd" + o.id, role: "sales_order" })),
    ];
    H.store.extraction_runs = [{ source_id: "d1", tenant_id: "t-1", extraction_kind: "sales_order", status_reason: "ok", finished_at: "2026-07-19T00:00:00Z", normalized_extract: goodExtract() }];
    H.store.item_customer_parts = [];
    return run().then((out) => {
      expect(out.statusCode).toBe(200);
      expect(out.body.available).toBe(true);
      expect(out.body.orders_compared).toBe(1);
      expect(out.body.orders.map((o) => o.order_id)).toEqual(["1"]);
    });
  });

  it("returns no_orders when the tenant has none", async () => {
    H.store.orders = [{ id: "z", tenant_id: "t-2", created_at: "2026-07-20T00:00:00Z" }];
    const out = await run();
    expect(out.body.available).toBe(false);
    expect(out.body.reason).toBe("no_orders");
  });

  it("returns no_sales_orders_attached when the tenant's orders have no SO", async () => {
    H.store.orders = [orderRow("1")];
    H.store.order_documents = [{ order_id: "1", document_id: "d1", role: "purchase_order" }];
    const out = await run();
    expect(out.body.available).toBe(false);
    expect(out.body.reason).toBe("no_sales_orders_attached");
  });

  it("picks the newest USABLE extract — an empty_lines re-run does not shadow an older good read", async () => {
    H.store.orders = [orderRow("1")];
    H.store.order_documents = [{ order_id: "1", document_id: "d1", role: "sales_order" }];
    H.store.extraction_runs = [
      // newest, but empty_lines (unusable) — must be skipped
      { source_id: "d1", tenant_id: "t-1", extraction_kind: "sales_order", status_reason: "empty_lines", finished_at: "2026-07-20T00:00:00Z", normalized_extract: { lines: [] } },
      // older, good — must win
      { source_id: "d1", tenant_id: "t-1", extraction_kind: "sales_order", status_reason: "ok", finished_at: "2026-07-18T00:00:00Z", normalized_extract: goodExtract() },
    ];
    H.store.item_customer_parts = [];
    const out = await run();
    expect(out.body.available).toBe(true);
    expect(out.body.orders_compared).toBe(1);
    // If it had taken the empty_lines run, every anvil line would read as
    // missing_from_erp; the good read means none are.
    expect(out.body.orders_with_missing_lines).toBe(0);
  });

  it("searches all of an order's attachments for a usable extract (not just the first)", async () => {
    H.store.orders = [orderRow("1")];
    H.store.order_documents = [
      { order_id: "1", document_id: "d1", role: "sales_order" }, // no usable run
      { order_id: "1", document_id: "d2", role: "sales_order" }, // the good one
    ];
    H.store.extraction_runs = [
      { source_id: "d2", tenant_id: "t-1", extraction_kind: "sales_order", status_reason: "ok", finished_at: "2026-07-18T00:00:00Z", normalized_extract: goodExtract() },
    ];
    H.store.item_customer_parts = [];
    const out = await run();
    expect(out.body.orders_compared).toBe(1);
    expect(out.body.skipped).toEqual([]);
  });

  it("keys the dual-code map with partKey so a lowercase-stored customer part still decides 'our part'", async () => {
    H.store.orders = [orderRow("1")];
    H.store.order_documents = [{ order_id: "1", document_id: "d1", role: "sales_order" }];
    H.store.extraction_runs = [{ source_id: "d1", tenant_id: "t-1", extraction_kind: "sales_order", status_reason: "ok", finished_at: "2026-07-19T00:00:00Z", normalized_extract: goodExtract() }];
    // stored lowercase + padded; the report looks it up as partKey("ABC-123")="ABC-123"
    H.store.item_customer_parts = [{ tenant_id: "t-1", customer_id: "c-1", item_id: "i-1", customer_part_number: " abc-123 ", valid_to: null }];
    H.store.item_master = [{ id: "i-1", tenant_id: "t-1", part_no: "OURPART" }];
    const out = await run();
    expect(out.body.available).toBe(true);
    // ourPartNo is decidable only if the map keyed/looked-up normalization agree.
    expect(out.body.by_field.map((f) => f.field)).toContain("ourPartNo");
  });
});
