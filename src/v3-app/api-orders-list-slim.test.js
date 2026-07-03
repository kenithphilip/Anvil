// Regression test for GET /api/orders (slim list) — src/api/orders/index.js.
//
// The Sales Orders screen calls orders.list({ slim: 1 }); the server's
// SLIM_COLS select must NOT name `currency` — there is no top-level
// orders.currency column (currency lives in result.salesOrder.currency).
// Selecting it threw "column orders.currency does not exist" ->
// "Failed to load orders" on the SO list. This locks the slim select to
// real columns + `result`.

import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ selects: [] }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: () => {
      const q = {
        select: (s) => { H.selects.push(s); return q; },
        eq: () => q, ilike: () => q, order: () => q, limit: () => q,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/orders/index.js");

const run = async (query) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "GET", headers: {}, url: "/api/orders", query }, res);
  return res;
};

describe("GET /api/orders slim list — no phantom orders.currency", () => {
  it("slim select never names currency and keeps result (currency derives from result.salesOrder)", async () => {
    H.selects = [];
    const res = await run({ slim: "1", limit: "50" });
    expect(res.statusCode).toBe(200);
    const sel = H.selects.join(" | ");
    expect(sel).not.toMatch(/\bcurrency\b/);
    expect(sel).toContain("result");
  });

  it("default (non-slim) select is unaffected", async () => {
    H.selects = [];
    const res = await run({ limit: "50" });
    expect(res.statusCode).toBe(200);
    expect(H.selects.join(" | ")).not.toMatch(/\bcurrency\b/);
  });
});
