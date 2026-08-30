// A service visit must be assignable to another person.
//
// field_engineer was hardcoded to whoever created the row and absent from the
// PATCH allow-list, so Anvil RECORDED field work but could not ROUTE it.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ members: [], written: null, visit: { id: "v-1" } }));

const ROLE = vi.hoisted(() => ({ value: "admin" }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "creator-1" }, tenantId: "t-1", role: ROLE.value })),
  requirePermission: vi.fn(() => {}),
  // Assignment is gated on the fine-grained action, not the coarse write verb.
  requireAction: vi.fn((ctx, action) => {
    const allow = { "service.assign": ["operator", "admin"] }[action];
    if (allow && !allow.includes(ctx.role)) {
      const e = new Error("Role " + ctx.role + " is not permitted to perform '" + action + "'");
      e.status = 403; throw e;
    }
  }),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const f = {};
      const api = {
        select: () => api, order: () => api, limit: () => api,
        eq(c, v) { f[c] = v; return api; },
        insert(row) { H.written = row; return { select: () => ({ single: async () => ({ data: { id: "v-1", ...row }, error: null }) }) }; },
        update(row) { H.written = row; return { eq: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { ...H.visit, ...row }, error: null }) }) }) }) }; },
        maybeSingle: async () => {
          if (table !== "tenant_members") return { data: null, error: null };
          const hit = H.members.find((m) => m.tenant_id === f.tenant_id && m.user_id === f.user_id && m.status === f.status);
          return { data: hit || null, error: null };
        },
        then: (r) => r({ data: [], error: null }),
      };
      return api;
    },
  }),
}));

const { default: handler } = await import("../api/service/visits.js");

const run = async ({ method, body, query = {} }) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method, headers: {}, url: "/api/service/visits", query, body: body || {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  ROLE.value = "admin";
  H.written = null;
  H.members = [
    { tenant_id: "t-1", user_id: "eng-1", status: "approved" },
    { tenant_id: "t-1", user_id: "pending-1", status: "pending" },
    { tenant_id: "t-OTHER", user_id: "foreign-1", status: "approved" },
  ];
});

describe("creating a visit", () => {
  it("assigns it to the named engineer instead of the creator", async () => {
    await run({ method: "POST", body: { visit_date: "2026-09-01", field_engineer: "eng-1" } });
    expect(H.written.field_engineer).toBe("eng-1");
  });

  it("still defaults to the creator when nobody is named (unchanged behaviour)", async () => {
    await run({ method: "POST", body: { visit_date: "2026-09-01" } });
    expect(H.written.field_engineer).toBe("creator-1");
  });

  it("REFUSES a foreign or unapproved assignee instead of silently assigning to the creator", async () => {
    // Silent fallback meant a dispatcher who picked a deactivated engineer got
    // the visit assigned to THEMSELVES, 201 and no warning: nobody dispatched,
    // and the record asserting the dispatcher did the field work.
    const foreign = await run({ method: "POST", body: { visit_date: "2026-09-01", field_engineer: "foreign-1" } });
    expect(foreign.statusCode).toBe(400);
    expect(H.written).toBeNull();
    const pending = await run({ method: "POST", body: { visit_date: "2026-09-01", field_engineer: "pending-1" } });
    expect(pending.statusCode).toBe(400);
    expect(H.written).toBeNull();
  });

  it("explicit null creates an UNASSIGNED visit (a queue nobody owns yet)", async () => {
    await run({ method: "POST", body: { visit_date: "2026-09-01", field_engineer: null } });
    expect(H.written.field_engineer).toBeNull();
  });
});

describe("reassigning a visit", () => {
  it("PATCH can now hand it to another approved member", async () => {
    const out = await run({ method: "PATCH", body: { id: "v-1", field_engineer: "eng-1" } });
    expect(out.statusCode).toBe(200);
    expect(H.written.field_engineer).toBe("eng-1");
  });

  it("REFUSES a user from another tenant (400, nothing written)", async () => {
    const out = await run({ method: "PATCH", body: { id: "v-1", field_engineer: "foreign-1" } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error.message).toMatch(/approved member of this tenant/);
    expect(H.written).toBeNull();
  });

  it("REFUSES an unapproved member", async () => {
    const out = await run({ method: "PATCH", body: { id: "v-1", field_engineer: "pending-1" } });
    expect(out.statusCode).toBe(400);
  });

  it("explicit null unassigns", async () => {
    await run({ method: "PATCH", body: { id: "v-1", field_engineer: null } });
    expect(H.written.field_engineer).toBeNull();
  });

  it("leaves the assignee alone when the patch does not mention it", async () => {
    await run({ method: "PATCH", body: { id: "v-1", status: "CHECKED_IN" } });
    expect("field_engineer" in H.written).toBe(false);
  });
});

describe("assignment is dispatch, not data entry", () => {
  it("a finance user — who cannot even SEE the visits screen — may not reassign", async () => {
    ROLE.value = "finance";
    const out = await run({ method: "PATCH", body: { id: "v-1", field_engineer: "eng-1" } });
    expect(out.statusCode).toBe(403);
    expect(H.written).toBeNull();
  });

  it("an operator may", async () => {
    ROLE.value = "operator";
    const out = await run({ method: "PATCH", body: { id: "v-1", field_engineer: "eng-1" } });
    expect(out.statusCode).toBe(200);
    expect(H.written.field_engineer).toBe("eng-1");
  });

  it("a non-assigning patch is unaffected by the gate", async () => {
    ROLE.value = "finance";
    const out = await run({ method: "PATCH", body: { id: "v-1", status: "CHECKED_IN" } });
    expect(out.statusCode).toBe(200);
  });
});
