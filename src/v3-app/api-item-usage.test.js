// Regression test for /api/admin/item_usage (backlog #15).
//
// Returns the orders/drafts whose line items reference a given
// item_master row. Match precedence:
//   1. line._mapped_item.id === item_id   (authoritative, stamped at
//      order-create by mapLinesToItemMaster)
//   2. one of the line's part-number candidates equals the item's
//      part_no / alias / specification_code (fallback for older or
//      unmapped lines)
//
// Locks: the mapped-id match, the identifier fallback, per-order qty
// aggregation, tenant scoping on both the item and the order query,
// and the 400 when item_id is absent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  item: null,
  orders: [],
  orderEq: {},
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({
    from: (table) => {
      if (table === "item_master") {
        const q = {
          select: () => q, eq: () => q,
          maybeSingle: async () => ({ data: h.item, error: null }),
        };
        return q;
      }
      // orders
      const q = {
        _eq: {},
        select: () => q,
        eq: (k, v) => { q._eq[k] = v; h.orderEq = q._eq; return q; },
        order: () => q,
        limit: () => q,
        then: (resolve) => resolve({ data: h.orders, error: null }),
      };
      return q;
    },
  })),
}));

const { default: handler } = await import("../api/admin/item_usage.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const run = async (query) => {
  const req = { method: "GET", headers: {}, query };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.item = {
    id: "item-1", part_no: "ATD NS HEAD ASSY", alias: "AS2-0061",
    specification_code: "AS2-0061", print_name: "ATD NS HEAD", created_at: "2026-01-01T00:00:00Z",
  };
  h.orders = [];
  h.orderEq = {};
});

describe("admin/item_usage", () => {
  it("400 when item_id is missing", async () => {
    const { res, parsed } = await run({});
    expect(res.statusCode).toBe(400);
    expect(parsed.error.message).toMatch(/item_id/);
  });

  it("404 when the item is not found in the tenant", async () => {
    h.item = null;
    const { res } = await run({ item_id: "ghost" });
    expect(res.statusCode).toBe(404);
  });

  it("matches an order via line._mapped_item.id and aggregates qty", async () => {
    h.orders = [
      {
        id: "ord-1", po_number: "P250432265", po_date: "2025-04-16", status: "APPROVED",
        created_at: "2025-04-16T00:00:00Z", customer: { customer_name: "Hyundai Motor India Ltd" },
        result: { salesOrder: { lineItems: [
          { description: "ATD NS HEAD ASSY", quantity: 2, _mapped_item: { id: "item-1", match_via: "item_master.part_no" } },
          { description: "OTHER", quantity: 9, _mapped_item: { id: "item-99" } },
        ] } },
      },
    ];
    const { res, parsed } = await run({ item_id: "item-1" });
    expect(res.statusCode).toBe(200);
    expect(parsed.order_count).toBe(1);
    expect(parsed.usage[0].po_number).toBe("P250432265");
    expect(parsed.usage[0].total_qty).toBe(2); // only the matching line
    expect(parsed.usage[0].customer_name).toMatch(/Hyundai/);
    // tenant scoping applied to the orders query
    expect(h.orderEq.tenant_id).toBe("t-1");
  });

  it("matches an order via identifier fallback when no _mapped_item.id", async () => {
    h.orders = [
      {
        id: "ord-2", po_number: "P-OLD", status: "DRAFT", created_at: "2025-01-01T00:00:00Z",
        customer: null,
        result: { salesOrder: { lineItems: [
          { partNumber: "AS2-0061", quantity: 3 }, // matches item.alias/spec, no _mapped_item
        ] } },
      },
    ];
    const { parsed } = await run({ item_id: "item-1" });
    expect(parsed.order_count).toBe(1);
    expect(parsed.usage[0].total_qty).toBe(3);
    expect(parsed.usage[0].match_via).toBe("identifier_fallback");
  });

  it("excludes orders that reference a different item", async () => {
    h.orders = [
      {
        id: "ord-3", po_number: "P-X", status: "DRAFT", created_at: "2025-02-01T00:00:00Z", customer: null,
        result: { salesOrder: { lineItems: [{ partNumber: "SOMETHING-ELSE", quantity: 1, _mapped_item: { id: "item-77" } }] } },
      },
    ];
    const { parsed } = await run({ item_id: "item-1" });
    expect(parsed.order_count).toBe(0);
    expect(parsed.usage).toEqual([]);
  });
});
