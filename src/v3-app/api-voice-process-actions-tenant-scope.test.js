// POST /api/voice/process_actions runs on the service role. The manual drain
// (an approver's button) used to read voice_call_actions with no tenant
// filter, so an approver in tenant A dispatched tenant B's voice actions too.
// The manual drain now reads only the caller's tenant; the cron drain still
// reads every tenant.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-secret";
  return { tenant: null, db: {}, reads: [] };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-approver" }, tenantId: H.tenant, role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const filters = [];
      let mode = "select";
      const api = {
        eqs: {},
        select: () => api,
        eq: (col, val) => { api.eqs[col] = val; filters.push((r) => r[col] === val); return api; },
        order: () => api,
        limit: () => api,
        insert: () => { mode = "write"; return api; },
        update: () => { mode = "write"; return api; },
        then: (resolve, reject) => {
          if (mode === "select") H.reads.push({ table, eqs: api.eqs });
          const data = mode === "select" ? (H.db[table] || []).filter((r) => filters.every((f) => f(r))) : null;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return api;
    },
  }),
}));

const { default: processActions } = await import("../api/voice/process_actions.js");

const run = async ({ tenant = null, bearer = "" } = {}) => {
  H.tenant = tenant;
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  const headers = bearer ? { authorization: "Bearer " + bearer } : {};
  await processActions({ method: "POST", headers, url: "/api/voice/process_actions", query: {}, body: {} }, res);
  const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return { statusCode: res.statusCode, body };
};

beforeEach(() => {
  H.reads = [];
  H.db = {
    voice_call_actions: [
      { id: "va-a", tenant_id: "tenant-a", action: "note", completed: false, created_at: "2026-10-01" },
      { id: "va-b", tenant_id: "tenant-b", action: "note", completed: false, created_at: "2026-10-02" },
    ],
  };
});

describe("process_actions drains only the caller's tenant on a manual run", () => {
  it("a manual drain by a tenant A approver dispatches tenant A's action only", async () => {
    const out = await run({ tenant: "tenant-a" });
    expect(out.statusCode).toBe(200);
    expect(out.body.results.map((r) => r.id)).toEqual(["va-a"]);
    const read = H.reads.find((r) => r.table === "voice_call_actions");
    expect(read.eqs.tenant_id).toBe("tenant-a");
  });

  it("the cron drain still dispatches every tenant's action", async () => {
    const out = await run({ bearer: "cron-secret" });
    expect(out.statusCode).toBe(200);
    expect(out.body.results.map((r) => r.id)).toEqual(["va-a", "va-b"]);
    const read = H.reads.find((r) => r.table === "voice_call_actions");
    expect(read.eqs.tenant_id).toBeUndefined();
  });
});
