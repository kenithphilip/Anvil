// Account owner on customers (migration 227).
//
// The owner is how an account reaches a rep's pipeline, chase list and
// follow-ups, so who may set it, who it may be set to, and which writers must
// leave it alone are the behaviour under test. The handlers run for real
// against an in-memory Supabase; auth.js is the REAL module (only
// resolveContext is overridden), so the customer.assign_owner gate and its
// SERVER_ACTIONS entry are exercised, not restated. recordAudit is real too:
// audit rows land in the in-memory audit_events table.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const H = vi.hoisted(() => ({ ctx: null, store: {}, noOwnerColumn: false, users: {}, calls: [], authCalls: [], failRead: {} }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

// ── in-memory Supabase ─────────────────────────────────────────────────────
// Enough of the PostgREST builder for these handlers: filters (eq, in, is,
// gte, not in, not is null, or), order, range, limit, select projection,
// update, insert, upsert-on-conflict, delete, maybeSingle/single. With
// H.noOwnerColumn set, the customers table behaves as it does before
// migration 227: rows have no owner_user_id, and any query that names the
// column fails with 42703. H.failRead[table] makes every read of that table
// fail with the given error (a statement timeout, say).
const missingOwner = () => ({ data: null, error: { code: "42703", message: "column customers.owner_user_id does not exist" } });
const makeSvc = () => ({
  auth: {
    admin: {
      getUserById: async (id) => {
        H.authCalls.push(id);
        if (H.authError) return { data: { user: null }, error: H.authError };
        return { data: { user: H.users[id] || null }, error: null };
      },
    },
  },
  from(table) {
    if (!H.store[table]) H.store[table] = [];
    const ds = H.store[table];
    const st = { filters: [], mode: "select", patch: null, row: null, onConflict: null, cols: "*", single: null, order: null, range: null, limit: null, names: [], inSizes: [] };
    const nameCol = (c) => { st.names.push(c); };
    const matches = (r) => st.filters.every((f) => f(r));
    const run = () => {
      H.calls.push({ table, mode: st.mode, names: [...st.names], cols: st.cols, patch: st.patch, row: st.row, inSizes: [...st.inSizes] });
      if (st.mode === "select" && H.failRead[table]) return { data: null, error: H.failRead[table] };
      if (table === "customers" && H.noOwnerColumn) {
        const touches = st.names.includes("owner_user_id") || /owner_user_id/.test(st.cols)
          || (st.patch && "owner_user_id" in st.patch) || (st.row && "owner_user_id" in st.row);
        if (touches) return missingOwner();
      }
      let out;
      if (st.mode === "update") {
        out = ds.filter(matches);
        for (const r of out) Object.assign(r, st.patch);
      } else if (st.mode === "insert") {
        const rows = Array.isArray(st.row) ? st.row : [st.row];
        for (const r of rows) ds.push({ id: r.id || "gen-" + ds.length, ...r });
        out = rows;
      } else if (st.mode === "delete") {
        out = ds.filter(matches);
        H.store[table] = ds.filter((r) => !matches(r));
      } else if (st.mode === "upsert") {
        const keys = (st.onConflict || "id").split(",");
        let hit = ds.find((r) => keys.every((k) => r[k] === st.row[k]));
        if (hit) Object.assign(hit, st.row);
        else { hit = { id: "gen-" + ds.length, ...st.row }; ds.push(hit); }
        out = [hit];
      } else {
        out = ds.filter(matches);
      }
      out = out.map((r) => {
        const copy = { ...r };
        if (table === "customers" && H.noOwnerColumn) delete copy.owner_user_id;
        return copy;
      });
      if (st.order) {
        const { col, asc } = st.order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) out = out.slice(0, st.limit);
      if (st.single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const b = {
      select(cols) { if (st.mode === "select") st.cols = cols || "*"; return b; },
      eq(c, v) { nameCol(c); st.filters.push((r) => r[c] === v); return b; },
      in(c, vs) { nameCol(c); st.inSizes.push(vs.length); st.filters.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { nameCol(c); st.filters.push((r) => (r[c] ?? null) === v); return b; },
      gte(c, v) { nameCol(c); st.filters.push((r) => r[c] >= v); return b; },
      not(c, op, v) {
        nameCol(c);
        if (op === "is" && v === null) { st.filters.push((r) => (r[c] ?? null) !== null); return b; }
        if (op !== "in") throw new Error("fake: not(" + op + ") unsupported");
        const list = String(v).replace(/^\(|\)$/g, "").split(",");
        st.filters.push((r) => !list.includes(r[c]));
        return b;
      },
      or(expr) {
        const parts = expr.split(",").map((p) => {
          const [c, op, ...rest] = p.split(".");
          nameCol(c);
          const val = rest.join(".");
          if (op === "is" && val === "null") return (r) => (r[c] ?? null) === null;
          if (op === "eq") return (r) => r[c] === val;
          throw new Error("fake: or(" + p + ") unsupported");
        });
        st.filters.push((r) => parts.some((fn) => fn(r)));
        return b;
      },
      order(col, opts) { st.order = { col, asc: !opts || opts.ascending !== false }; return b; },
      range(from, to) { st.range = [from, to]; return b; },
      limit(n) { st.limit = n; return b; },
      update(patch) { st.mode = "update"; st.patch = patch; return b; },
      insert(row) { st.mode = "insert"; st.row = row; return b; },
      upsert(row, opts) { st.mode = "upsert"; st.row = row; st.onConflict = opts && opts.onConflict; return b; },
      delete() { st.mode = "delete"; return b; },
      maybeSingle() { st.single = "maybe"; return Promise.resolve(run()); },
      single() { st.single = "one"; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  },
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

const { default: ownerHandler } = await import("../api/customers/owner.js");
const { default: customersHandler } = await import("../api/customers/index.js");
const { default: membersHandler } = await import("../api/admin/members.js");
const { creditReviewRequest } = await import("../api/agents/_handlers/credit_review_request.js");
const { SERVER_ACTIONS } = await import("../api/_lib/auth.js");
const { ACTIONS } = await import("./lib/rbac");
const { default: mergeHandler } = await import("../api/customers/merge.js");
const { fetchAllRows, tallyOwners, strictMajorityOwner, isMissingOwnerColumn, OWNER_READ_PAGING } = await import("../api/_lib/customer-owner.js");

const call = async (handler, { method = "GET", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method, headers: {}, url: "/api/x", query, body: body || {} }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

// Ids are uuid-shaped: the endpoint refuses anything else before it reaches
// the database, where a malformed uuid would be a 500.
const T1 = "t-1";
const T2 = "t-2";
const MGR = "aaaaaaaa-0000-4000-8000-000000000001";   // sales_manager, caller
const U2 = "aaaaaaaa-0000-4000-8000-000000000002";    // approved member
const U3 = "aaaaaaaa-0000-4000-8000-000000000003";    // approved member
const PENDING = "aaaaaaaa-0000-4000-8000-000000000004";
const FOREIGN = "aaaaaaaa-0000-4000-8000-000000000005"; // approved, other tenant
const GONE = "aaaaaaaa-0000-4000-8000-000000000006";    // owns history, no longer a member
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const C3 = "cccccccc-0000-4000-8000-000000000003";
const CX = "cccccccc-0000-4000-8000-0000000000ff";      // tenant t-2's customer

const asRole = (role, userId = MGR) => { H.ctx = { user: { id: userId }, tenantId: T1, role, anonymous: false }; };
const daysAgo = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString();
const customer = (id) => H.store.customers.find((c) => c.id === id);
const auditRows = () => (H.store.audit_events || []).filter((a) => a.action === "customer_owner_change");
const oppAuditRows = () => (H.store.audit_events || []).filter((a) => a.action === "opp_owner_change");

beforeEach(() => {
  H.noOwnerColumn = false;
  H.calls = [];
  H.authCalls = [];
  H.authError = null;
  H.failRead = {};
  H.users = {
    [MGR]: { id: MGR, email: "mgr@seller.test", user_metadata: { name: "Meera Manager" } },
    [U2]: { id: U2, email: "ravi@seller.test", user_metadata: { name: "Ravi Rep" } },
    [U3]: { id: U3, email: "sana@seller.test", user_metadata: { full_name: "Sana Sales" } },
  };
  H.store = {
    tenant_members: [
      { tenant_id: T1, user_id: MGR, role: "sales_manager", status: "approved" },
      { tenant_id: T1, user_id: U2, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: U3, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: PENDING, role: "sales_engineer", status: "pending" },
      { tenant_id: T2, user_id: FOREIGN, role: "sales_engineer", status: "approved" },
    ],
    customers: [
      { id: C1, tenant_id: T1, customer_key: "acme", customer_name: "Acme", owner_user_id: null, updated_at: daysAgo(1) },
      { id: C2, tenant_id: T1, customer_key: "bolt", customer_name: "Bolt", owner_user_id: U3, updated_at: daysAgo(2) },
      { id: C3, tenant_id: T1, customer_key: "core", customer_name: "Core", owner_user_id: null, updated_at: daysAgo(3) },
      { id: CX, tenant_id: T2, customer_key: "xeno", customer_name: "Xeno", owner_user_id: null, updated_at: daysAgo(1) },
    ],
    opportunities: [],
    quotes: [],
    audit_events: [],
  };
});

describe("POST /api/customers/owner: who may assign", () => {
  it("a sales_manager assigns the owner, and one audit row per customer records before and after", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1, C2], owner_user_id: U2, move_open_opportunities: false } });
    expect(r.status).toBe(200);
    expect(customer(C1).owner_user_id).toBe(U2);
    expect(customer(C2).owner_user_id).toBe(U2);
    expect(r.body.updated.sort()).toEqual([C1, C2].sort());
    const audits = auditRows();
    expect(audits.map((a) => a.object_id).sort()).toEqual([C1, C2].sort());
    const c2 = audits.find((a) => a.object_id === C2);
    expect(c2.before_payload).toEqual({ owner_user_id: U3 });
    expect(c2.after_payload.owner_user_id).toBe(U2);
    expect(c2.actor).toBe(MGR);
  });

  it("sales_engineer gets 403 from the real customer.assign_owner gate, and nothing is written", async () => {
    asRole("sales_engineer", U2);
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: U2, move_open_opportunities: false } });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/customer\.assign_owner/);
    expect(customer(C1).owner_user_id).toBeNull();
  });

  it("finance, procurement and operator hold the write verb but not the action: 403", async () => {
    for (const role of ["finance", "procurement", "operator"]) {
      asRole(role);
      const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: U2, move_open_opportunities: false } });
      expect(r.status, role).toBe(403);
    }
    expect(customer(C1).owner_user_id).toBeNull();
  });

  it("admin may assign", async () => {
    asRole("admin");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: U3, move_open_opportunities: false } });
    expect(r.status).toBe(200);
    expect(customer(C1).owner_user_id).toBe(U3);
  });
});

describe("POST /api/customers/owner: who the owner may be", () => {
  it("a user who is not a member of this tenant returns 400 and changes nothing", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: FOREIGN, move_open_opportunities: false } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/approved member of this tenant/);
    expect(customer(C1).owner_user_id).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it("a pending (unapproved) member returns 400", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: PENDING, move_open_opportunities: false } });
    expect(r.status).toBe(400);
    expect(customer(C1).owner_user_id).toBeNull();
  });

  it("a malformed id is a 400, not a database error", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: "u-2", move_open_opportunities: false } });
    expect(r.status).toBe(400);
  });

  it("an explicit null unassigns", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: null, move_open_opportunities: false } });
    expect(r.status).toBe(200);
    expect(customer(C2).owner_user_id).toBeNull();
    expect(auditRows()[0].before_payload).toEqual({ owner_user_id: U3 });
  });

  it("a body that FORGOT owner_user_id is refused rather than read as unassign", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], move_open_opportunities: false } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/owner_user_id is required/);
    expect(customer(C2).owner_user_id).toBe(U3);
  });
});

describe("POST /api/customers/owner: a large selection", () => {
  it("assigns 150 accounts with no id filter carrying more than 100 ids", async () => {
    // An in.(...) filter rides in the URL: 500 uuids would be about 18 KB.
    const many = Array.from({ length: 150 }, (_, i) => "dddddddd-0000-4000-8000-" + String(i).padStart(12, "0"));
    H.store.customers.push(...many.map((id) => ({ id, tenant_id: T1, customer_key: id, customer_name: id, owner_user_id: null })));
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: many, owner_user_id: U2, move_open_opportunities: true } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toHaveLength(150);
    expect(many.every((id) => customer(id).owner_user_id === U2)).toBe(true);
    const sizes = H.calls.flatMap((c) => c.inSizes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(auditRows()).toHaveLength(150);
  });
});

describe("POST /api/customers/owner: which customers", () => {
  it("another tenant's customer id is rejected, and the batch is not partly applied", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1, CX], owner_user_id: U2, move_open_opportunities: false } });
    expect(r.status).toBe(404);
    expect(r.body.error.customer_ids).toEqual([CX]);
    expect(customer(C1).owner_user_id).toBeNull();
    expect(customer(CX).owner_user_id).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it("an empty selection is a 400", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [], owner_user_id: U2 } });
    expect(r.status).toBe(400);
  });

  it("before migration 227 it says so (409) instead of failing obscurely", async () => {
    asRole("sales_manager");
    H.noOwnerColumn = true;
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1], owner_user_id: U2, move_open_opportunities: false } });
    expect(r.status).toBe(409);
    expect(r.body.error.migration).toBe("227_customer_owner.sql");
  });
});

describe("POST /api/customers/owner: moving open opportunities", () => {
  const STALE = daysAgo(200);
  beforeEach(() => {
    H.store.opportunities = [
      { id: "o-prev", tenant_id: T1, customer_id: C2, owner_id: U3, stage: "RFQ", updated_at: STALE },
      { id: "o-nobody", tenant_id: T1, customer_id: C2, owner_id: null, stage: "QUALIFICATION", updated_at: STALE },
      { id: "o-other-rep", tenant_id: T1, customer_id: C2, owner_id: MGR, stage: "RFQ", updated_at: STALE },
      { id: "o-closed", tenant_id: T1, customer_id: C2, owner_id: U3, stage: "CLOSE_WON", updated_at: STALE },
      { id: "o-other-acct", tenant_id: T1, customer_id: C1, owner_id: U3, stage: "RFQ", updated_at: STALE },
    ];
  });
  const ownerOf = (id) => H.store.opportunities.find((o) => o.id === id).owner_id;
  const opp = (id) => H.store.opportunities.find((o) => o.id === id);

  it("moves the previous owner's and nobody's OPEN opportunities on that account, and nothing else", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: true } });
    expect(r.status).toBe(200);
    expect(ownerOf("o-prev")).toBe(U2);
    expect(ownerOf("o-nobody")).toBe(U2);
    expect(ownerOf("o-other-rep")).toBe(MGR);
    expect(ownerOf("o-closed")).toBe(U3);
    expect(ownerOf("o-other-acct")).toBe(U3);
    expect(r.body.moved_opportunities).toBe(2);
    expect(auditRows()[0].after_payload.moved_opportunity_ids.sort()).toEqual(["o-nobody", "o-prev"]);
  });

  it("writes an audit row per moved opportunity naming who held it before, so the move can be undone", async () => {
    asRole("sales_manager");
    await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: true } });
    const rows = oppAuditRows();
    expect(rows.map((a) => a.object_id).sort()).toEqual(["o-nobody", "o-prev"]);
    for (const a of rows) {
      expect(a.object_type).toBe("opportunity");
      expect(a.after_payload).toEqual({ owner_id: U2 });
      expect(a.actor).toBe(MGR);
    }
    expect(rows.find((a) => a.object_id === "o-prev").before_payload).toEqual({ owner_id: U3 });
    expect(rows.find((a) => a.object_id === "o-nobody").before_payload).toEqual({ owner_id: null });
  });

  it("a move is not activity on the deal: updated_at is left as it was", async () => {
    asRole("sales_manager");
    await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: true } });
    expect(ownerOf("o-prev")).toBe(U2);
    expect(opp("o-prev").updated_at).toBe(STALE);
    expect(opp("o-nobody").updated_at).toBe(STALE);
  });

  it("each account moves only what ITS previous owner held: one batch over accounts with different owners", async () => {
    // C2 was U3's, so U3's open deal on C2 moves. C1 was nobody's, so U3's
    // deal on C1 is U3's own pipeline and stays; only C1's unowned deal moves.
    H.store.opportunities.push({ id: "o-c1-nobody", tenant_id: T1, customer_id: C1, owner_id: null, stage: "RFQ", updated_at: STALE });
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C1, C2], owner_user_id: U2, move_open_opportunities: true } });
    expect(r.status).toBe(200);
    expect(ownerOf("o-prev")).toBe(U2);
    expect(ownerOf("o-nobody")).toBe(U2);
    expect(ownerOf("o-c1-nobody")).toBe(U2);
    expect(ownerOf("o-other-acct")).toBe(U3);
    expect(ownerOf("o-other-rep")).toBe(MGR);
    expect(r.body.moved_opportunities).toBe(3);
    const byCustomer = Object.fromEntries(auditRows().map((a) => [a.object_id, a.after_payload.moved_opportunity_ids.sort()]));
    expect(byCustomer).toEqual({ [C1]: ["o-c1-nobody"], [C2]: ["o-nobody", "o-prev"] });
  });

  it("writes every audit row of the request in one insert, not one round trip per row", async () => {
    asRole("sales_manager");
    await call(ownerHandler, { method: "POST", body: { customer_ids: [C1, C2, C3], owner_user_id: U2, move_open_opportunities: true } });
    const inserts = H.calls.filter((c) => c.table === "audit_events" && c.mode === "insert");
    expect(inserts).toHaveLength(1);
    // 3 customers changed, 2 opportunities moved.
    expect(inserts[0].row).toHaveLength(5);
    expect(auditRows()).toHaveLength(3);
  });

  it("pages past the first page of open opportunities, and moves none it could not read in full", async () => {
    const pad = (n) => String(n).padStart(2, "0");
    H.store.opportunities = Array.from({ length: 5 }, (_, i) => ({ id: "o-" + pad(i), tenant_id: T1, customer_id: C2, owner_id: U3, stage: "RFQ" }));
    const saved = { ...OWNER_READ_PAGING };
    asRole("sales_manager");
    try {
      // Three pages of two: all five read, all five moved.
      Object.assign(OWNER_READ_PAGING, { pageSize: 2, maxPages: 3 });
      const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: true } });
      expect(r.body.moved_opportunities).toBe(5);
      expect(H.store.opportunities.every((o) => o.owner_id === U2)).toBe(true);
      // Two pages of two: the read stops short, so nothing moves and the
      // response says the owner was saved without the opportunities.
      for (const o of H.store.opportunities) o.owner_id = U3;
      customer(C2).owner_user_id = U3;
      Object.assign(OWNER_READ_PAGING, { pageSize: 2, maxPages: 2 });
      const capped = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: true } });
      expect(capped.status).toBe(200);
      expect(customer(C2).owner_user_id).toBe(U2);
      expect(capped.body.moved_opportunities).toBe(0);
      expect(H.store.opportunities.every((o) => o.owner_id === U3)).toBe(true);
      expect(capped.body.warnings).toHaveLength(1);
      expect(capped.body.warnings[0].customer_ids).toEqual([C2]);
      expect(capped.body.warnings[0].message).toMatch(/owner saved; open opportunities on 1 account not moved/);
    } finally {
      Object.assign(OWNER_READ_PAGING, saved);
    }
  });

  it("leaves opportunities alone when the box is not ticked", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: U2, move_open_opportunities: false } });
    expect(r.status).toBe(200);
    expect(customer(C2).owner_user_id).toBe(U2);
    expect(ownerOf("o-prev")).toBe(U3);
    expect(ownerOf("o-nobody")).toBeNull();
  });

  it("refuses to move opportunities to nobody", async () => {
    asRole("sales_manager");
    const r = await call(ownerHandler, { method: "POST", body: { customer_ids: [C2], owner_user_id: null, move_open_opportunities: true } });
    expect(r.status).toBe(400);
    expect(customer(C2).owner_user_id).toBe(U3);
  });
});

describe("GET /api/customers/owner?suggest=1: a strict majority or nothing", () => {
  const opp = (customerId, owner, updatedDaysAgo = 10, id) => ({ id: id || "o-" + Math.random().toString(36).slice(2), tenant_id: T1, customer_id: customerId, owner_id: owner, stage: "RFQ", updated_at: daysAgo(updatedDaysAgo) });
  const quote = (customerId, author, createdDaysAgo = 10, id) => ({ id: id || "q-" + Math.random().toString(36).slice(2), tenant_id: T1, customer_id: customerId, created_by: author, created_at: daysAgo(createdDaysAgo) });
  const suggestionFor = (body, id) => body.suggestions.find((s) => s.customer_id === id);

  it("suggests the member who owns more than half of the opportunities and authored quotes", async () => {
    asRole("sales_engineer", U2);
    H.store.opportunities = [opp(C1, U2), opp(C1, U3)];
    H.store.quotes = [quote(C1, U2), quote(C1, U2)];
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    expect(r.status).toBe(200);
    const s = suggestionFor(r.body, C1);
    expect(s.owner_user_id).toBe(U2);
    expect(s.votes).toBe(3);
    expect(s.total).toBe(4);
    expect(s.owner_name).toBe("Ravi Rep");
  });

  it("a tie is NOT a majority: exactly half suggests nobody", async () => {
    asRole("sales_engineer", U2);
    H.store.opportunities = [opp(C1, U2), opp(C1, U3)];
    H.store.quotes = [quote(C1, U2), quote(C1, U3)];
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    const s = suggestionFor(r.body, C1);
    expect(s.owner_user_id).toBeNull();
    expect(s.reason).toBe("no_majority");
    expect(s.total).toBe(4);
  });

  it("an unowned opportunity counts toward the total: 1 of 2 is not a majority", async () => {
    asRole("sales_engineer", U2);
    H.store.opportunities = [opp(C1, null)];
    H.store.quotes = [quote(C1, U2)];
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    const s = suggestionFor(r.body, C1);
    expect(s.owner_user_id).toBeNull();
    expect(s.reason).toBe("no_majority");
    expect(s.total).toBe(2);
  });

  it("an uploaded quote (no author) is nobody's vote: the rep who wrote the in-app quotes is suggested", async () => {
    // _lib/quote-ingest.js builds the quote head without created_by. Counting
    // those would make 2 of 5 and bury the only author on the account.
    asRole("sales_engineer", U2);
    H.store.quotes = [quote(C1, U2), quote(C1, U2), quote(C1, null), quote(C1, null), quote(C1, null)];
    const r = await call(ownerHandler, { query: { suggest: "1", customer_id: C1 } });
    expect(r.body.suggestions[0]).toMatchObject({ owner_user_id: U2, reason: "majority", votes: 2, total: 2 });
  });

  it("ignores evidence older than 365 days and evidence from another tenant", async () => {
    asRole("sales_engineer", U2);
    H.store.opportunities = [opp(C1, U3, 400), opp(C1, U3, 400), { ...opp(C1, U3), tenant_id: T2 }];
    H.store.quotes = [quote(C1, U2, 30)];
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    const s = suggestionFor(r.body, C1);
    expect(s.owner_user_id).toBe(U2);
    expect(s.total).toBe(1);
  });

  it("does not offer a majority owner who is no longer an approved member", async () => {
    asRole("sales_engineer", U2);
    H.store.quotes = [quote(C1, GONE), quote(C1, GONE), quote(C1, U2)];
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    const s = suggestionFor(r.body, C1);
    expect(s.owner_user_id).toBeNull();
    expect(s.reason).toBe("not_a_member");
  });

  it("lists every UNOWNED customer of the tenant and no owned or foreign one", async () => {
    asRole("sales_engineer", U2);
    const r = await call(ownerHandler, { query: { suggest: "1" } });
    expect(r.body.suggestions.map((s) => s.customer_id).sort()).toEqual([C1, C3].sort());
    expect(suggestionFor(r.body, C3).reason).toBe("no_activity");
  });

  it("narrows to one customer when customer_id is given", async () => {
    asRole("sales_engineer", U2);
    H.store.quotes = [quote(C3, U3)];
    const r = await call(ownerHandler, { query: { suggest: "1", customer_id: C3 } });
    expect(r.body.suggestions).toHaveLength(1);
    expect(r.body.suggestions[0]).toMatchObject({ customer_id: C3, owner_user_id: U3 });
  });

  it("reads past the first 1000 rows: the majority is decided on ALL the evidence", async () => {
    // Ids sort A's quotes first. PostgREST would return only the first 1000
    // rows, on which U3 leads 600 to 400; across all 1500, U2 holds 900.
    asRole("sales_engineer", U2);
    const pad = (n) => String(n).padStart(5, "0");
    H.store.quotes = [
      ...Array.from({ length: 600 }, (_, i) => quote(C1, U3, 10, "a-" + pad(i))),
      ...Array.from({ length: 900 }, (_, i) => quote(C1, U2, 10, "b-" + pad(i))),
    ];
    const r = await call(ownerHandler, { query: { suggest: "1", customer_id: C1 } });
    expect(r.body.suggestions[0]).toMatchObject({ owner_user_id: U2, votes: 900, total: 1500 });
    expect(r.body.complete).toBe(true);
  });

  it("refuses to suggest from evidence it could not read in full", async () => {
    // U2 leads on every page that WAS read; the cap stops the read before the
    // rest. A guess about the unread part is not offered as a suggestion.
    asRole("sales_engineer", U2);
    const pad = (n) => String(n).padStart(3, "0");
    H.store.quotes = Array.from({ length: 5 }, (_, i) => quote(C1, U2, 10, "q-" + pad(i)));
    const saved = { ...OWNER_READ_PAGING };
    Object.assign(OWNER_READ_PAGING, { pageSize: 2, maxPages: 2 });
    try {
      const r = await call(ownerHandler, { query: { suggest: "1", customer_id: C1 } });
      expect(r.status).toBe(200);
      expect(r.body.complete).toBe(false);
      expect(r.body.suggestions[0]).toMatchObject({ customer_id: C1, owner_user_id: null, reason: "evidence_incomplete" });
    } finally {
      Object.assign(OWNER_READ_PAGING, saved);
    }
    // The same evidence read in full does suggest U2.
    const full = await call(ownerHandler, { query: { suggest: "1", customer_id: C1 } });
    expect(full.body.suggestions[0]).toMatchObject({ owner_user_id: U2, votes: 5, total: 5 });
  });

  it("does not write anything", async () => {
    asRole("sales_manager");
    H.store.quotes = [quote(C1, U2)];
    await call(ownerHandler, { query: { suggest: "1" } });
    expect(customer(C1).owner_user_id).toBeNull();
    expect(H.calls.filter((c) => c.mode !== "select").map((c) => c.table)).toEqual([]);
    expect(H.calls.some((c) => c.table === "quotes")).toBe(true);
  });
});

describe("customer-owner helpers", () => {
  it("strictMajorityOwner needs more than half", () => {
    const t = tallyOwners([
      { customer_id: "c", owner: "a" }, { customer_id: "c", owner: "a" },
      { customer_id: "c", owner: "b" }, { customer_id: "c", owner: null },
    ]).get("c");
    expect(t.total).toBe(4);
    expect(strictMajorityOwner(t)).toBeNull();
    t.votes.set("a", 3); t.total = 4;
    expect(strictMajorityOwner(t)).toEqual({ owner: "a", votes: 3, total: 4 });
  });

  it("fetchAllRows reports an incomplete read instead of passing a slice off as the whole", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ n }));
    const make = () => ({ range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }) });
    const capped = await fetchAllRows(make, { pageSize: 2, maxPages: 2 });
    expect(capped.complete).toBe(false);
    expect(capped.rows).toHaveLength(4);
    const full = await fetchAllRows(make, { pageSize: 2, maxPages: 5 });
    expect(full.complete).toBe(true);
    expect(full.rows).toHaveLength(5);
  });

  it("isMissingOwnerColumn matches only the owner column", () => {
    expect(isMissingOwnerColumn({ code: "42703", message: "column customers.owner_user_id does not exist" })).toBe(true);
    expect(isMissingOwnerColumn({ code: "PGRST204", message: "Could not find the 'owner_user_id' column of 'customers' in the schema cache" })).toBe(true);
    expect(isMissingOwnerColumn({ code: "42703", message: "column customers.credit_limit does not exist" })).toBe(false);
  });
});

describe("GET /api/customers: owner and owner filter", () => {
  it("returns owner_user_id, and the owner's display name when asked (include=owner_name)", async () => {
    asRole("viewer");
    const r = await call(customersHandler, { query: { include: "owner_name" } });
    expect(r.status).toBe(200);
    expect(H.authCalls).toEqual([U3]);
    const bolt = r.body.customers.find((c) => c.id === C2);
    expect(bolt.owner_user_id).toBe(U3);
    expect(bolt.owner_name).toBe("Sana Sales");
    const acme = r.body.customers.find((c) => c.id === C1);
    expect(acme.owner_user_id).toBeNull();
    expect(acme.owner_name).toBeNull();
    expect(r.body.customers.map((c) => c.id)).not.toContain(CX);
  });

  it("without include=owner_name it makes no auth lookup (a picker does not pay for names)", async () => {
    asRole("viewer");
    const r = await call(customersHandler);
    expect(r.status).toBe(200);
    const bolt = r.body.customers.find((c) => c.id === C2);
    expect(bolt.owner_user_id).toBe(U3);
    expect("owner_name" in bolt).toBe(false);
    expect(H.calls.some((c) => c.table === "customers" && c.mode === "select")).toBe(true);
    expect(H.authCalls).toEqual([]);
  });

  it("owner=me is the caller's accounts", async () => {
    asRole("sales_engineer", U3);
    const r = await call(customersHandler, { query: { owner: "me" } });
    expect(r.body.customers.map((c) => c.id)).toEqual([C2]);
  });

  it("owner=none is the unassigned accounts", async () => {
    asRole("sales_engineer", U3);
    const r = await call(customersHandler, { query: { owner: "none" } });
    expect(r.body.customers.map((c) => c.id).sort()).toEqual([C1, C3].sort());
  });

  it("owner=<member id> is that member's accounts", async () => {
    asRole("sales_manager");
    const r = await call(customersHandler, { query: { owner: U3 } });
    expect(r.body.customers.map((c) => c.id)).toEqual([C2]);
  });

  it("an owner value that is none of those is a 400, not an unfiltered list", async () => {
    asRole("sales_manager");
    const r = await call(customersHandler, { query: { owner: "ravi" } });
    expect(r.status).toBe(400);
  });

  it("before migration 227 the owner degrades: nobody owns anything, the list still loads", async () => {
    asRole("sales_engineer", U3);
    H.noOwnerColumn = true;
    const all = await call(customersHandler);
    expect(all.status).toBe(200);
    expect(all.body.customers).toHaveLength(3);
    expect(all.body.customers.every((c) => c.owner_user_id === null)).toBe(true);
    const none = await call(customersHandler, { query: { owner: "none" } });
    expect(none.status).toBe(200);
    expect(none.body.customers).toHaveLength(3);
    expect(none.body.warning).toBe("owner_unavailable");
    const mine = await call(customersHandler, { query: { owner: "me" } });
    expect(mine.status).toBe(200);
    expect(mine.body.customers).toEqual([]);
    expect(mine.body.warning).toBe("owner_unavailable");
  });
});

describe("POST /api/customers never writes the owner", () => {
  it("a body carrying owner_user_id (as the hierarchy panel's full-row save does) leaves the owner untouched", async () => {
    asRole("admin");
    const r = await call(customersHandler, {
      method: "POST",
      body: { customer_key: "bolt", customer_name: "Bolt Industries", owner_user_id: U2, owner_name: "Ravi Rep" },
    });
    expect(r.status).toBe(200);
    // The write ran and landed the edit...
    expect(customer(C2).customer_name).toBe("Bolt Industries");
    // ...and the owner is still the one the owner endpoint set.
    expect(customer(C2).owner_user_id).toBe(U3);
    // An existing customer is now updated with only the keys the body carries
    // (#555), not upserted whole; either way the written row has no owner.
    const write = H.calls.find((c) => c.table === "customers" && (c.mode === "update" || c.mode === "upsert"));
    expect(write).toBeTruthy();
    const written = write.patch || write.row;
    expect(written.customer_name).toBe("Bolt Industries");
    expect("owner_user_id" in written).toBe(false);
  });

  it("nor does a body WITHOUT owner_user_id clear it", async () => {
    asRole("admin");
    const r = await call(customersHandler, { method: "POST", body: { customer_key: "bolt", customer_name: "Bolt Two" } });
    expect(r.status).toBe(200);
    expect(customer(C2).customer_name).toBe("Bolt Two");
    expect(customer(C2).owner_user_id).toBe(U3);
  });
});

describe("GET /api/admin/members returns each member's status", () => {
  it("so a picker can offer only approved members", async () => {
    asRole("sales_manager");
    const r = await call(membersHandler);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.members.map((m) => [m.user_id, m.status]));
    expect(byId[U2]).toBe("approved");
    expect(byId[PENDING]).toBe("pending");
    expect(Object.keys(byId)).not.toContain(FOREIGN);
  });
});

describe("credit_review_request reads the account owner", () => {
  const goal = { tenant_id: T1, object_id: C2, last_action_at: null, config: {} };
  beforeEach(() => {
    Object.assign(customer(C2), { credit_limit: 1000, currency: "INR" });
    H.store.invoices = [{ tenant_id: T1, customer_id: C2, grand_total: 950, paid_amount: 0, status: "sent" }];
    H.store.tenant_settings = [];
  });

  it("emails the owner, found through auth (there is no users table)", async () => {
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("send_email");
    expect(out.action_payload.to).toBe("sana@seller.test");
    expect(H.calls.some((c) => c.table === "users")).toBe(false);
  });

  it("does not email an owner who is no longer an approved member, and says that is why", async () => {
    H.store.tenant_members = H.store.tenant_members.filter((m) => m.user_id !== U3);
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("owner_not_member");
    expect(out.thought).toMatch(/no longer an approved member/);
    expect(H.authCalls).toEqual([]);
  });

  it("a failed membership read is a retry, not an escalation with a false reason", async () => {
    H.failRead.tenant_members = { code: "57014", message: "canceling statement due to statement timeout" };
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("noop");
    expect(out.thought).toMatch(/statement timeout/);
  });

  it("a failed auth lookup of the owner is a retry too", async () => {
    H.authError = { status: 503, message: "auth service unavailable" };
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("noop");
    expect(out.thought).toMatch(/auth service unavailable/);
  });

  it("an owner whose login has no email escalates with that reason", async () => {
    H.users[U3] = { id: U3, user_metadata: { full_name: "Sana Sales" } };
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("owner_has_no_email");
    expect(out.thought).toMatch(/no email address/);
  });

  it("with no owner and no finance alias it escalates as before", async () => {
    customer(C2).owner_user_id = null;
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("no_internal_recipient");
  });

  it("still runs before migration 227: the owner column is dropped, the finance alias is used", async () => {
    H.noOwnerColumn = true;
    H.store.tenant_settings = [{ tenant_id: T1, finance_email: "fin@seller.test" }];
    const out = await creditReviewRequest(goal, { svc: makeSvc() });
    expect(out.action).toBe("send_email");
    expect(out.action_payload.to).toBe("fin@seller.test");
  });
});

describe("POST /api/customers/merge keeps the account owner", () => {
  const D1 = "cccccccc-0000-4000-8000-0000000000d1";
  const D2 = "cccccccc-0000-4000-8000-0000000000d2";
  const merge = (primary, dups) => call(mergeHandler, { method: "POST", body: { primary_id: primary, duplicate_ids: dups } });
  const mergeAudit = () => H.store.audit_events.find((a) => a.action === "customer_merge");
  beforeEach(() => {
    H.store.customers.push(
      { id: D1, tenant_id: T1, customer_key: "acme-sap", customer_name: "ACME (SAP)", owner_user_id: U2 },
      { id: D2, tenant_id: T1, customer_key: "acme-ns", customer_name: "ACME (NS)", owner_user_id: null },
    );
  });

  it("an unowned primary takes the owner its duplicates agree on, and the audit says so", async () => {
    asRole("admin");
    const r = await merge(C1, [D1, D2]);
    expect(r.status).toBe(200);
    expect(customer(C1).owner_user_id).toBe(U2);
    expect(customer(D1)).toBeUndefined();
    expect(mergeAudit().after_payload.owner).toEqual({
      outcome: "carried", owner_user_id: U2, duplicate_owners: [{ customer_id: D1, owner_user_id: U2 }],
    });
  });

  it("duplicates with DIFFERENT owners leave the primary unassigned, and both owners are on the audit", async () => {
    customer(D2).owner_user_id = U3;
    asRole("admin");
    const r = await merge(C1, [D1, D2]);
    expect(r.status).toBe(200);
    expect(customer(C1).owner_user_id).toBeNull();
    const audit = mergeAudit().after_payload.owner;
    expect(audit.outcome).toBe("conflict_left_unassigned");
    expect(audit.duplicate_owners.map((d) => d.owner_user_id).sort()).toEqual([U2, U3].sort());
  });

  it("an owned primary keeps its owner, and the duplicate's owner is recorded", async () => {
    asRole("admin");
    await merge(C2, [D1]);
    expect(customer(C2).owner_user_id).toBe(U3);
    expect(mergeAudit().after_payload.owner).toMatchObject({ outcome: "primary_kept", owner_user_id: U3 });
  });

  it("before migration 227 it never writes the owner column", async () => {
    H.noOwnerColumn = true;
    asRole("admin");
    const r = await merge(C1, [D1]);
    expect(r.status).toBe(200);
    const patch = H.calls.find((c) => c.table === "customers" && c.mode === "update").patch;
    expect(patch.external_ref).toBeDefined();
    expect("owner_user_id" in patch).toBe(false);
  });
});

describe("customer.assign_owner is registered on both sides", () => {
  it("is in SERVER_ACTIONS and rbac.ts ACTIONS with the same roles", () => {
    // An action missing from SERVER_ACTIONS admits every role (hasAction
    // returns true for an unknown name); one missing from ACTIONS shows the
    // controls to everyone.
    expect(SERVER_ACTIONS["customer.assign_owner"]).toBeInstanceOf(Set);
    expect([...SERVER_ACTIONS["customer.assign_owner"]].sort()).toEqual(["admin", "sales_manager"]);
    expect([...ACTIONS["customer.assign_owner"]].sort()).toEqual(["admin", "sales_manager"]);
  });
});

describe("migration 227", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(HERE, "..", "..", "supabase", "migrations", "227_customer_owner.sql"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("adds the column idempotently with the same FK shape as opportunities.owner_id", () => {
    expect(sql).toMatch(/alter table customers\s+add column if not exists owner_user_id uuid null references auth\.users\(id\) on delete set null/i);
  });

  it("creates the partial owner index idempotently", () => {
    expect(sql).toMatch(/create index if not exists customers_owner_idx\s+on customers \(tenant_id, owner_user_id\)\s+where owner_user_id is not null/i);
  });

  it("does not backfill an owner", () => {
    expect(sql).not.toMatch(/\bupdate\s+customers\b/i);
  });
});
