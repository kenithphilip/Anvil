// A customer portal identity cannot be approved or invited as staff.
//
// ensureMembership refuses to insert a tenant_members row for a portal
// identity, but rows created BEFORE that guard (a portal invitee who reached a
// staff sign-in) still sit pending, one Approve click from staff access. The
// staff invite path upserts tenant_members for whatever auth user the invite
// returns. Both now check portal_users first. Drives the real handlers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-000000000001";

let tables;
let errors;
let inviteReturns;

const makeSvc = () => ({
  auth: { admin: {
    inviteUserByEmail: async () => ({ data: { user: { id: inviteReturns } }, error: null }),
    updateUserById: async () => ({ data: {}, error: null }),
    getUserById: async () => ({ data: { user: null }, error: null }),
  } },
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select"; let payload = null; let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vals) => { const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[c]))); return b; },
      order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      upsert: (row) => { mode = "upsert"; payload = row; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      then: (fn, rej) => Promise.resolve(terminal()).then(fn, rej),
    };
    const terminal = () => {
      if (mode === "select" && errors[table]) return { data: null, error: errors[table] };
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "upsert" || mode === "insert") { const row = { created_at: "2026-10-05", ...payload }; ds.push(row); return { data: single ? row : [row], error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message, status: err.status || 500 } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc(), userClient: () => ({}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/mailer.js", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "admin1" }, role: "admin" }),
  requirePermission: () => {},
}));

const { default: accessRequests } = await import("../api/admin/access_requests.js");
const { default: members } = await import("../api/admin/members.js");

const run = async (handler, req) => {
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler({ headers: {}, query: {}, ...req }, res);
  return res;
};

beforeEach(() => {
  tables = { tenant_members: [], portal_users: [], audit_events: [] };
  errors = {};
  inviteReturns = "authNew";
});

describe("admin/access_requests approve", () => {
  it("refuses to approve a portal identity's pending row, and leaves it pending", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authP", role: "sales_engineer", requested_role: "sales_engineer", status: "pending" }];
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authP", status: "active" }];
    const res = await run(accessRequests, { method: "POST", _body: { user_id: "authP", action: "approve" } });
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("PORTAL_ACCOUNT");
    expect(tables.tenant_members[0].status).toBe("pending");
    expect(tables.tenant_members[0].approved_by).toBeUndefined();
  });

  it("still lets the admin deny that row", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authP", role: "sales_engineer", status: "pending" }];
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authP", status: "active" }];
    const res = await run(accessRequests, { method: "POST", _body: { user_id: "authP", action: "deny", reason: "customer portal account" } });
    expect(res._status).toBe(200);
    expect(tables.tenant_members[0].status).toBe("denied");
  });

  it("approves an ordinary staff request", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authS", role: "sales_engineer", requested_role: "sales_manager", status: "pending" }];
    const res = await run(accessRequests, { method: "POST", _body: { user_id: "authS", action: "approve" } });
    expect(res._status).toBe(200);
    expect(tables.tenant_members[0].status).toBe("approved");
    expect(tables.tenant_members[0].role).toBe("sales_manager");
  });

  it("approves as before when portal_users does not exist yet (42P01)", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authS", role: "sales_engineer", status: "pending" }];
    errors.portal_users = { code: "42P01", message: 'relation "portal_users" does not exist' };
    const res = await run(accessRequests, { method: "POST", _body: { user_id: "authS", action: "approve" } });
    expect(res._status).toBe(200);
    expect(tables.tenant_members[0].status).toBe("approved");
  });

  it("fails closed with 500 on any other portal_users error, approving nothing", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authS", role: "sales_engineer", status: "pending" }];
    errors.portal_users = { code: "08006", message: "connection failure" };
    const res = await run(accessRequests, { method: "POST", _body: { user_id: "authS", action: "approve" } });
    expect(res._status).toBe(500);
    expect(tables.tenant_members[0].status).toBe("pending");
  });
});

describe("admin/members invite", () => {
  it("refuses to invite an email that belongs to a portal user, and writes no membership", async () => {
    inviteReturns = "authP";
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authP", status: "active" }];
    const res = await run(members, { method: "POST", _body: { email: "buyer@oem.com", role: "sales_engineer" } });
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("PORTAL_ACCOUNT");
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("invites an ordinary staff email", async () => {
    inviteReturns = "authNew";
    const res = await run(members, { method: "POST", _body: { email: "rep@seller.com", role: "sales_engineer" } });
    expect(res._status).toBe(200);
    expect(tables.tenant_members).toHaveLength(1);
    expect(tables.tenant_members[0].user_id).toBe("authNew");
  });
});
