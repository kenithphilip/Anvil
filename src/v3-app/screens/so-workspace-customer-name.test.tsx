// The SO workspace header names the order's customer.
//
// The header line read order.customer.customer_name, and GET /api/orders/[id]
// never set it: the row is select("*") with no join. So every order opened in
// the workspace showed its customer_id prefix ("a1b2c3d4 · created ..."), and
// only test fixtures that put a customer_name on the order by hand ever showed
// a name. These tests run the REAL handler and feed its response to the screen.
//
// Every name and id here is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const DB = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const api: any = {
      select: () => api,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; },
      single: async () => { const r = rows()[0]; return r ? { data: { ...r }, error: null } : { data: null, error: { message: "no rows" } }; },
      maybeSingle: async () => ({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
      then: (resolve: any) => resolve({ data: rows(), error: null }),
    };
    return api;
  };
  return { tables, from };
});

vi.mock("../../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
  requireAction: vi.fn(() => {}),
  hasPermission: vi.fn(() => true),
}));
vi.mock("../../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: DB.from }) }));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));

const ORDER_ID = "ord-hdr-1";
const CUSTOMER_ID = "a1b2c3d4-0000-4000-8000-000000000001";

const callGet = async () => {
  const handler = (await import("../../api/orders/[id].js")).default;
  let body: any = null;
  const res: any = {
    statusCode: 200, headers: {},
    setHeader() {}, status(c: number) { this.statusCode = c; return this; },
    json(o: any) { body = o; return this; }, send(p: any) { body = typeof p === "string" ? JSON.parse(p) : p; return this; },
    end() { return this; },
  };
  await handler({ method: "GET", headers: {}, query: { id: ORDER_ID }, url: "/api/orders/" + ORDER_ID }, res);
  return { status: res.statusCode, body };
};

const seed = (order: any, customers: any[]) => {
  DB.tables.orders = [order];
  DB.tables.customers = customers;
};
const ORDER = (over: any = {}) => ({
  id: ORDER_ID, tenant_id: "t-1", status: "PENDING_REVIEW", po_number: "PO-FX-0001",
  customer_id: CUSTOMER_ID,
  // As production stored it: the extractor found no buyer block.
  result: { salesOrder: { customer: null, lineItems: [{ partNumber: "FX-1", description: "Fixture item", qty: 1, rate: 10 }] } },
  preflight_payload: {},
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...over,
});

const mount = async (order: any) => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const r = renderScreen(mod.default);
  await waitFor(() => expect(r.container.innerHTML).toContain("Line reconciliation"));
  return r.container;
};
// The header line: "<customer> · created ... · updated ...".
const headerCustomer = (c: HTMLElement) => {
  const created = Array.from(c.querySelectorAll("span")).find((s) => /^created /.test(s.textContent || ""));
  return created?.parentElement?.querySelector("span")?.textContent || null;
};

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("GET /api/orders/[id] carries the customer's name", () => {
  it("attaches the order's customer record, scoped to the tenant", async () => {
    seed(ORDER(), [
      { id: CUSTOMER_ID, tenant_id: "t-other", customer_name: "Someone Else's Buyer" },
      { id: CUSTOMER_ID, tenant_id: "t-1", customer_name: "Fixture Buyer Industries", state_code: "27" },
    ]);
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.order.customer).toMatchObject({ customer_name: "Fixture Buyer Industries", state_code: "27" });
  });

  it("still returns the order when the customer record is gone", async () => {
    seed(ORDER(), []);
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.order.id).toBe(ORDER_ID);
    expect(body.order.customer).toBeUndefined();
  });
});

describe("the workspace header", () => {
  it("shows the customer's name, not the id prefix, when the PO block has no buyer", async () => {
    seed(ORDER(), [{ id: CUSTOMER_ID, tenant_id: "t-1", customer_name: "Fixture Buyer Industries" }]);
    const { body } = await callGet();
    const c = await mount(body.order);
    expect(headerCustomer(c)).toBe("Fixture Buyer Industries");
  });

  it("shows the PO's buyer name for an order not yet linked to a customer", async () => {
    const c = await mount(ORDER({ customer_id: null, result: { salesOrder: { customer: { name: "Fixture Buyer From PO" }, lineItems: [] } } }));
    expect(headerCustomer(c)).toBe("Fixture Buyer From PO");
  });

  it("falls back to the id prefix, not the PO's text, when a linked customer cannot be read", async () => {
    const c = await mount(ORDER({ result: { salesOrder: { customer: { name: "Text On The PO" }, lineItems: [] } } }));
    expect(headerCustomer(c)).toBe(CUSTOMER_ID.slice(0, 8));
  });
});
