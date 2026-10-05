// The portal's unsafe holes, closed before any customer is invited
// (docs/ACCOUNTS_ASSETS_PORTAL_SCOPE.md, PR 1).
//
// Every test here drives the real handler against an in-memory Supabase
// stand-in and asserts on what was (or was not) written. None of them reads a
// handler's source.
//
//   1. portal/accept_quote: the order path set ANY order of the token's
//      customer to APPROVED. It now answers 410 and writes nothing.
//   2. portal/accept_quote: a quote with no customer skipped the customer
//      check, so any accept_quote token in the tenant could accept it.
//   3. portal/accept_quote: the audit insert named `actor_id`, a column that
//      does not exist, so every acceptance audit row was lost.
//   4. _lib/tenancy ensureMembership: a portal identity was onboarded into
//      tenant_members as staff, through five callers.
//   5. portal/view: the order status list named two values that are not in
//      the order_status enum, and legacy kind=invoices served drafts and voids.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TENANT = "00000000-0000-0000-0000-000000000001";

// The order_status enum, read from the migration that defines it, so the
// stand-in below rejects an unknown label the way Postgres does (22P02).
const ORDER_STATUS_ENUM = (() => {
  const sql = readFileSync(join(HERE, "..", "..", "supabase/migrations/001_init.sql"), "utf8");
  const m = sql.match(/create type order_status as enum \(([^)]*)\)/);
  return m[1].split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean);
})();

let tables;
let errors;     // table -> { code, message } returned by the next read of that table
let rpcCalls;

const makeSvc = () => ({
  auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  rpc: async (fn, params) => {
    rpcCalls.push({ fn, params });
    if (fn !== "claim_tenant_membership") return { data: null, error: { message: "unknown rpc" } };
    const row = { tenant_id: params.p_tenant_id, user_id: params.p_user_id, role: params.p_default_role, status: "pending" };
    (tables.tenant_members ||= []).push(row);
    return { data: [{ out_tenant_id: row.tenant_id, out_role: row.role, out_status: row.status, out_requested_role: null, out_was_first: false }], error: null };
  },
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select"; let payload = null; let single = false; let enumError = null; let proj = null;
    const b = {
      // A select list is honoured, so a test can see exactly which columns
      // a handler would have sent back.
      select: (cols) => { if (mode === "select" && typeof cols === "string" && cols.trim() !== "*") proj = cols.split(",").map((c) => c.trim()).filter(Boolean); return b; },
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      is: (c, v) => { rows = rows.filter((r) => (v === null ? r[c] == null : String(r[c]) === String(v))); return b; },
      in: (c, vals) => {
        if (table === "orders" && c === "status") {
          const bad = vals.find((v) => !ORDER_STATUS_ENUM.includes(v));
          if (bad) enumError = { code: "22P02", message: 'invalid input value for enum order_status: "' + bad + '"' };
        }
        const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[c]))); return b;
      },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      upsert: (row) => { mode = "upsert"; payload = row; return b; },
      then: (fn, rej) => Promise.resolve(terminal()).then(fn, rej),
    };
    const terminal = () => {
      if (mode === "select" && errors[table]) { const e = errors[table]; return { data: null, error: e }; }
      if (enumError) return { data: null, error: enumError };
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert" || mode === "upsert") {
        const arr = (Array.isArray(payload) ? payload : [payload]).map((r, i) => ({ id: r.id || (table + "-" + (ds.length + i + 1)), accepted_at: r.accepted_at, ...r }));
        ds.push(...arr);
        return { data: single ? arr[0] : arr, error: null };
      }
      const pick = (r) => (proj ? Object.fromEntries(proj.filter((c) => c in r).map((c) => [c, r[c]])) : r);
      return { data: single ? (rows[0] ? pick(rows[0]) : null) : rows.map(pick), error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  // Same shape as the real sendError (cors.js): message and status only.
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message, status: err.status || 500 } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  // The bearer / access token value IS the auth user id in these tests.
  userClient: (token) => ({ auth: { getUser: async () => ({ data: { user: { id: token, email: token + "@example.com" } }, error: null }) } }),
}));
const signOuts = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email }) => ({ data: { user: { id: "auth-" + email, email }, session: { access_token: "AT" } }, error: null }),
      signOut: async () => { signOuts.push(1); return {}; },
    },
  }),
}));

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon";

const { default: acceptQuote } = await import("../api/portal/accept_quote.js");
const { default: portalView } = await import("../api/portal/view.js");
const { default: verify } = await import("../api/auth/verify.js");
const { default: passwordLogin } = await import("../api/auth/password_login.js");
const { ensureMembership } = await import("../api/_lib/tenancy.js");
const { resolveContext } = await import("../api/_lib/auth.js");

const run = async (handler, req) => {
  const res = { setHeader() {}, _status: 0, _json: null, status(s) { this._status = s; return this; }, send() { return this; } };
  await handler({ headers: {}, ...req }, res);
  return res;
};

beforeEach(() => {
  tables = {
    portal_tokens: [], quotes: [], orders: [], invoices: [], portal_quote_acceptances: [],
    audit_events: [], audit_failures: [], portal_access_log: [], portal_users: [],
    tenant_members: [], tenants: [{ id: TENANT }], customers: [], user_security_settings: [],
  };
  errors = {};
  rpcCalls = [];
  signOuts.length = 0;
});

const token = (over = {}) => ({ id: "tok1", tenant_id: TENANT, customer_id: "c1", token: "TK", scopes: ["accept_quote", "orders", "invoices", "quotes"], revoked_at: null, expires_at: null, ...over });

describe("portal/accept_quote", () => {
  it("retires the order path: 410, and no order is touched", async () => {
    tables.portal_tokens = [token()];
    tables.orders = [{ id: "o1", tenant_id: TENANT, customer_id: "c1", status: "PENDING_REVIEW", approval: null }];
    const res = await run(acceptQuote, { method: "POST", _body: { token: "TK", order_id: "o1", signature_name: "Ravi" } });
    expect(res._status).toBe(410);
    expect(res._json.error.code).toBe("ORDER_ACCEPT_RETIRED");
    expect(tables.orders[0].status).toBe("PENDING_REVIEW");
    expect(tables.orders[0].approval).toBeNull();
    expect(tables.portal_quote_acceptances).toHaveLength(0);
  });

  it("answers 410 for the order path even with no valid token", async () => {
    const res = await run(acceptQuote, { method: "POST", _body: { token: "nope", order_id: "o1", signature_name: "Ravi" } });
    expect(res._status).toBe(410);
  });

  it("refuses a quote that has no customer, and leaves it SENT", async () => {
    tables.portal_tokens = [token()];
    tables.quotes = [{ id: "q1", tenant_id: TENANT, customer_id: null, status: "SENT", version: 1 }];
    const res = await run(acceptQuote, { method: "POST", _body: { token: "TK", quote_id: "q1", signature_name: "Ravi" } });
    expect(res._status).toBe(403);
    expect(tables.quotes[0].status).toBe("SENT");
    expect(tables.portal_quote_acceptances).toHaveLength(0);
  });

  it("refuses when the token has no customer, even for a quote that has one", async () => {
    tables.portal_tokens = [token({ customer_id: null })];
    tables.quotes = [{ id: "q1", tenant_id: TENANT, customer_id: "c1", status: "SENT", version: 1 }];
    const res = await run(acceptQuote, { method: "POST", _body: { token: "TK", quote_id: "q1", signature_name: "Ravi" } });
    expect(res._status).toBe(403);
    expect(tables.quotes[0].status).toBe("SENT");
  });

  it("accepts the customer's own SENT quote and writes an audit row with `actor`, not `actor_id`", async () => {
    tables.portal_tokens = [token()];
    tables.quotes = [{ id: "q1", tenant_id: TENANT, customer_id: "c1", status: "SENT", version: 2 }];
    const res = await run(acceptQuote, { method: "POST", _body: { token: "TK", quote_id: "q1", signature_name: "Ravi" } });
    expect(res._status).toBe(200);
    expect(tables.quotes[0].status).toBe("ACCEPTED");
    expect(tables.portal_quote_acceptances).toHaveLength(1);
    expect(tables.audit_events).toHaveLength(1);
    const row = tables.audit_events[0];
    expect(row.action).toBe("portal_quote_accepted");
    expect(row.object_id).toBe("q1");
    expect(Object.prototype.hasOwnProperty.call(row, "actor")).toBe(true);
    expect(row.actor).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(row, "actor_id")).toBe(false);
    expect(row.detail).toContain("by=Ravi");
  });
});

describe("ensureMembership never onboards a portal identity as staff", () => {
  const portalUser = (authId) => ({ id: "pu1", tenant_id: TENANT, customer_id: "c1", auth_user_id: authId, status: "invited" });

  it("throws 403 PORTAL_ACCOUNT and inserts nothing", async () => {
    tables.portal_users = [portalUser("authP")];
    await expect(ensureMembership(makeSvc(), { id: "authP" })).rejects.toMatchObject({ status: 403, code: "PORTAL_ACCOUNT" });
    expect(rpcCalls).toHaveLength(0);
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("refuses through resolveContext (staff API with a portal JWT)", async () => {
    tables.portal_users = [portalUser("authP")];
    await expect(resolveContext({ headers: { authorization: "Bearer authP" } })).rejects.toMatchObject({ status: 403, code: "PORTAL_ACCOUNT" });
    expect(rpcCalls).toHaveLength(0);
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("refuses through auth/verify (the magic-link and invite callback)", async () => {
    tables.portal_users = [portalUser("authP")];
    const res = await run(verify, { method: "POST", _body: { access_token: "authP" } });
    expect(res._status).toBe(403);
    expect(res._json.error.message).toMatch(/customer portal account/i);
    expect(rpcCalls).toHaveLength(0);
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("refuses through auth/password_login before a staff session is returned", async () => {
    tables.portal_users = [portalUser("auth-buyer@oem.com")];
    const res = await run(passwordLogin, { method: "POST", _body: { email: "buyer@oem.com", password: "pw" } });
    expect(res._status).toBe(403);
    expect(res._json.error.message).toMatch(/customer portal account/i);
    expect(res._json.session).toBeUndefined();
    expect(signOuts).toHaveLength(1);
    expect(rpcCalls).toHaveLength(0);
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("leaves an existing staff member untouched even if a portal row shares the auth id", async () => {
    tables.tenant_members = [{ tenant_id: TENANT, user_id: "authS", role: "sales_manager", status: "approved" }];
    tables.portal_users = [portalUser("authS")];
    const rows = await ensureMembership(makeSvc(), { id: "authS" });
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("sales_manager");
    expect(rpcCalls).toHaveLength(0);
  });

  it("onboards as before when portal_users does not exist yet (migration 199 not applied, 42P01)", async () => {
    errors.portal_users = { code: "42P01", message: 'relation "portal_users" does not exist' };
    const rows = await ensureMembership(makeSvc(), { id: "authNew", email: "new@seller.com" });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["claim_tenant_membership"]);
    expect(rows).toHaveLength(1);
    expect(tables.tenant_members).toHaveLength(1);
  });

  it("onboards as before on PostgREST's missing-table code (PGRST205)", async () => {
    errors.portal_users = { code: "PGRST205", message: "Could not find the table 'public.portal_users' in the schema cache" };
    await ensureMembership(makeSvc(), { id: "authNew2" });
    expect(rpcCalls).toHaveLength(1);
  });

  it("fails closed with 500 on any other portal_users error", async () => {
    errors.portal_users = { code: "08006", message: "connection failure" };
    await expect(ensureMembership(makeSvc(), { id: "authNew3" })).rejects.toMatchObject({ status: 500 });
    expect(rpcCalls).toHaveLength(0);
    expect(tables.tenant_members).toHaveLength(0);
  });

  it("onboards an ordinary new staff user", async () => {
    const rows = await ensureMembership(makeSvc(), { id: "authStaff", email: "rep@seller.com" });
    expect(rows).toHaveLength(1);
    expect(tables.tenant_members).toHaveLength(1);
  });
});

describe("portal/view customer-visible statuses", () => {
  it("serves the customer's approved orders: the status filter is accepted by the enum", async () => {
    tables.portal_tokens = [token()];
    tables.orders = ORDER_STATUS_ENUM.map((s, i) => ({ id: "o" + i, tenant_id: TENANT, customer_id: "c1", status: s, created_at: "2026-10-0" + ((i % 9) + 1) }));
    const res = await run(portalView, { method: "GET", url: "/api/portal/view?kind=orders&token=TK" });
    expect(res._status).toBe(200);
    const statuses = res._json.orders.map((o) => o.status).sort();
    expect(statuses).toEqual(["APPROVED", "EXPORTED_TO_TALLY", "RECONCILED"]);
  });

  it("serves order rows through the allowlist only: no result blob, no internal ids or hashes", async () => {
    tables.portal_tokens = [token()];
    tables.orders = [{
      id: "o1", tenant_id: TENANT, customer_id: "c1", status: "APPROVED", created_at: "2026-10-01",
      quote_number: "Q-202610-0001", po_number: "4500313249", payload_hash: "h", tally_status: "pushed",
      result: { validatorIssues: ["x"], external_systems: { sap: { last_error: "internal" } } },
    }];
    for (const kind of ["orders", "quotes"]) {
      const res = await run(portalView, { method: "GET", url: "/api/portal/view?kind=" + kind + "&token=TK" });
      expect(res._status).toBe(200);
      const rows = res._json[kind];
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "po_number", "quote_number", "status"]);
      expect(rows[0].po_number).toBe("4500313249");
    }
  });

  it("legacy kind=invoices serves issued invoices only, never draft or void", async () => {
    tables.portal_tokens = [token()];
    const all = ["draft", "sent", "partial", "paid", "overdue", "void"];
    tables.invoices = all.map((s, i) => ({ id: "i" + i, tenant_id: TENANT, customer_id: "c1", status: s, issue_date: "2026-09-0" + (i + 1) }));
    const res = await run(portalView, { method: "GET", url: "/api/portal/view?kind=invoices&token=TK" });
    expect(res._status).toBe(200);
    const statuses = res._json.invoices.map((r) => r.status).sort();
    expect(statuses).toEqual(["overdue", "paid", "partial", "sent"]);
  });
});
