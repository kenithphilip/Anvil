// Tests for customer portal auth v1: per-user session identity
// (resolveCustomerContext), the dual-auth portal/view (session preferred, legacy
// token still accepted), and the internal invite/manage endpoint.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

let tables;
const makeSvc = () => ({
  // Supabase admin (invite). Returns a deterministic auth id per email.
  auth: { admin: { inviteUserByEmail: async (email) => ({ data: { user: { id: "auth-" + email } }, error: null }) } },
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select"; let payload = null; let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      is: (c, v) => { rows = rows.filter((r) => (v === null ? r[c] == null : String(r[c]) === String(v))); return b; },
      in: (c, vals) => { const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[c]))); return b; },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      upsert: (row) => { mode = "upsert"; payload = row; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    let idc = 0;
    const terminal = () => {
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert" || mode === "upsert") { const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || ("id-" + table + "-" + (++idc)), ...r })); ds.push(...arr); return { data: single ? arr[0] : arr, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  // The Bearer token value IS the auth-user id for tests.
  userClient: (token) => ({ auth: { getUser: async () => (token ? { data: { user: { id: token } }, error: null } : { data: null, error: { message: "no user" } }) } }),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "staff1" }, role: "admin" }),
  requirePermission: () => {},
}));

import { resolveCustomerContext } from "../api/_lib/portal-auth.js";
import portalView from "../api/portal/view.js";
import portalInvite from "../api/portal/auth/invite.js";

const bearer = (id) => ({ headers: { authorization: "Bearer " + id } });
const run = async (handler, req) => { const res = { setHeader() {}, _status: 0, _json: null }; await handler(req, res); return res; };

beforeEach(() => { tables = { portal_users: [], portal_tokens: [], spare_matrix: [], customers: [], portal_access_log: [], spare_matrix_columns: [], spare_matrix_rows: [], gun_drawings: [] }; });

describe("resolveCustomerContext (per-user session identity)", () => {
  it("resolves an active portal user from a Bearer JWT", async () => {
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authX", status: "active", role: "portal_member", email: "buyer@oem.com" }];
    const ctx = await resolveCustomerContext(bearer("authX"));
    expect(ctx.customerId).toBe("c1");
    expect(ctx.portalUserId).toBe("pu1");
  });
  it("401 without an Authorization header", async () => {
    await expect(resolveCustomerContext({ headers: {} })).rejects.toMatchObject({ status: 401 });
  });
  it("403 for a JWT that maps to NO portal_users row (staff token can't reach the portal)", async () => {
    await expect(resolveCustomerContext(bearer("staffToken"))).rejects.toMatchObject({ status: 403 });
  });
  it("403 for a suspended portal user", async () => {
    tables.portal_users = [{ id: "pu2", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authY", status: "suspended", role: "portal_member", email: "x@y.com" }];
    await expect(resolveCustomerContext(bearer("authY"))).rejects.toMatchObject({ status: 403 });
  });
});

describe("portal/view dual-auth", () => {
  const viewReq = (kind, headers = {}) => ({ method: "GET", url: "/api/portal/view?kind=" + kind, headers, _body: null });

  it("SESSION (Bearer, no URL token) returns the user's own customer matrices", async () => {
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: "authX", status: "active", role: "portal_member", email: "b@oem.com" }];
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "Servo Guns", project_name: "L" }];
    const res = await run(portalView, viewReq("spares", { authorization: "Bearer authX" }));
    expect(res._status).toBe(200);
    expect(res._json.spare_matrices.map((m) => m.id)).toEqual(["m1"]);
  });

  it("LEGACY token still works (scope-gated)", async () => {
    tables.portal_tokens = [{ id: "t1", tenant_id: TENANT, customer_id: "c1", token: "TK", scopes: ["spares"], revoked_at: null }];
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "M", project_name: "L" }];
    const res = await run(portalView, { method: "GET", url: "/api/portal/view?kind=spares&token=TK", headers: {}, _body: null });
    expect(res._status).toBe(200);
    expect(res._json.spare_matrices.length).toBe(1);
  });

  it("401 with neither a session nor a token", async () => {
    const res = await run(portalView, viewReq("spares"));
    expect(res._status).toBe(401);
  });
});

describe("portal/auth/invite (internal)", () => {
  const post = (body) => run(portalInvite, { method: "POST", query: {}, _body: body, headers: {} });

  it("invites a customer user: creates a Supabase auth user + a portal_users row", async () => {
    tables.customers = [{ id: "c1", tenant_id: TENANT }];
    const res = await post({ customer_id: "c1", email: "Buyer@OEM.com", role: "portal_admin" });
    expect(res._status).toBe(200);
    expect(res._json.portal_user.status).toBe("invited");
    expect(res._json.portal_user.email).toBe("buyer@oem.com");     // lowercased
    expect(res._json.portal_user.auth_user_id).toBe("auth-buyer@oem.com");
    expect(tables.portal_users.length).toBe(1);
  });

  it("404 when the customer isn't in the tenant; 400 without email/customer", async () => {
    expect((await post({ customer_id: "ghost", email: "a@b.com" }))._status).toBe(404);
    expect((await post({ email: "a@b.com" }))._status).toBe(400);
  });

  it("suspends an existing portal user", async () => {
    tables.portal_users = [{ id: "pu1", tenant_id: TENANT, customer_id: "c1", status: "active" }];
    const res = await post({ user_id: "pu1", action: "suspend" });
    expect(res._status).toBe(200);
    expect(tables.portal_users[0].status).toBe("suspended");
  });
});
