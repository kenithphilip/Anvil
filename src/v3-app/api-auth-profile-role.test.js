// GET /api/auth/profile returns the caller's server role (ctx.role).
//
// The v3 app sets its button gates from this value (lib/rbac.ts
// setServerRole). memberships lists every tenant, so it cannot say which
// role THIS request's tenant gives; ctx.role is what every server gate checks.

import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null }));
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => H.ctx) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        then: (resolve) => resolve({ data: [
          { tenant_id: "t-1", role: "sales_engineer" },
          { tenant_id: "t-2", role: "admin" },
        ], error: null }),
      };
      return q;
    },
  }),
}));
const { default: handler } = await import("../api/auth/profile.js");

const get = async () => {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, send(p) { this.body = p; return this; }, end() { return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/auth/profile" }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

describe("GET /api/auth/profile role", () => {
  it("returns the role of the request's tenant, not another membership's", async () => {
    H.ctx = { user: { id: "u-1", email: "a@example.test" }, tenantId: "t-2", role: "admin", anonymous: false };
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
    H.ctx = { user: { id: "u-1", email: "a@example.test" }, tenantId: "t-1", role: "sales_engineer", anonymous: false };
    expect((await get()).body.role).toBe("sales_engineer");
  });

  it("refuses an anonymous caller, so the app falls back to viewer", async () => {
    H.ctx = { user: null, tenantId: "t-1", role: "sales_engineer", anonymous: true };
    const r = await get();
    expect(r.status).toBe(401);
    expect(r.body.role).toBeUndefined();
  });
});
