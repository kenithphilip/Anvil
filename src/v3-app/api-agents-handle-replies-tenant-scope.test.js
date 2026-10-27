// POST /api/agents/handle_replies runs on the service role. The manual drain
// (an approver's button) used to read inbound_emails with no tenant filter, so
// an approver in tenant A handled tenant B's replies too. The manual drain now
// reads only the caller's tenant; the cron drain still reads every tenant.

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
        in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return api; },
        is: (col, val) => { filters.push((r) => (r[col] ?? null) === val); return api; },
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

const { default: handleReplies } = await import("../api/agents/handle_replies.js");

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
  await handleReplies({ method: "POST", headers, url: "/api/agents/handle_replies", query: {}, body: {} }, res);
  const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return { statusCode: res.statusCode, body };
};

beforeEach(() => {
  H.reads = [];
  H.db = {
    inbound_emails: [
      { id: "em-a", tenant_id: "tenant-a", classified_intent: "complaint", received_at: "2026-10-01" },
      { id: "em-b", tenant_id: "tenant-b", classified_intent: "complaint", received_at: "2026-10-02" },
    ],
  };
});

describe("handle_replies drains only the caller's tenant on a manual run", () => {
  it("a manual drain by a tenant A approver handles tenant A's email only", async () => {
    const out = await run({ tenant: "tenant-a" });
    expect(out.statusCode).toBe(200);
    expect(out.body.results.map((r) => r.id)).toEqual(["em-a"]);
    const read = H.reads.find((r) => r.table === "inbound_emails");
    expect(read.eqs.tenant_id).toBe("tenant-a");
  });

  it("the cron drain still handles every tenant's email", async () => {
    const out = await run({ bearer: "cron-secret" });
    expect(out.statusCode).toBe(200);
    expect(out.body.results.map((r) => r.id)).toEqual(["em-a", "em-b"]);
    const read = H.reads.find((r) => r.table === "inbound_emails");
    expect(read.eqs.tenant_id).toBeUndefined();
  });
});
