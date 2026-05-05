// Behavioral tests for ensureMembership.
//
// Co-located with the v3-app vitest root (the rest of the api/ folder
// is not in the test include glob). Drives the helper through a thin
// stub that mimics the supabase-js query builder API surface we use:
// from().select().eq() and from().insert().select(). Lets us assert
// the onboarding logic without standing up a real Postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureMembership, defaultTenantId } from "../api/_lib/tenancy.js";

const userA = { id: "11111111-1111-1111-1111-111111111111", email: "a@example.com" };
const userB = { id: "22222222-2222-2222-2222-222222222222", email: "b@example.com" };
const TENANT_ID = defaultTenantId();

const makeStub = ({ memberships = [], tenants = [{ id: TENANT_ID }] }) => {
  const insertedMembers = [];
  const insertedTenants = [];
  const stub = {
    from: vi.fn((table) => {
      const builder = {
        _table: table,
        _eq: null,
        _selectArgs: null,
        select(...args) { this._selectArgs = args; return this; },
        eq(col, val) { this._eq = { col, val }; return this; },
        maybeSingle() {
          if (this._table === "tenants" && this._eq?.col === "id") {
            const found = tenants.find((t) => t.id === this._eq.val) || null;
            return Promise.resolve({ data: found, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          if (this._table === "tenant_members") {
            if (this._selectArgs?.[1]?.head === true) {
              const count = memberships.filter((m) => m.tenant_id === this._eq.val).length;
              return resolve({ data: null, count, error: null });
            }
            const matches = memberships.filter((m) => m.user_id === this._eq.val);
            return resolve({ data: matches, error: null });
          }
          return resolve({ data: null, error: null });
        },
        insert(row) {
          const next = Object.assign({}, this);
          if (this._table === "tenant_members") {
            insertedMembers.push(row);
            memberships.push(row);
          } else if (this._table === "tenants") {
            insertedTenants.push(row);
            tenants.push(row);
          }
          next.select = () => ({ then: (resolve) => resolve({ data: [row], error: null }) });
          return next;
        },
      };
      return builder;
    }),
    _insertedMembers: insertedMembers,
    _insertedTenants: insertedTenants,
    // Mock the Postgres RPC introduced in 059_security_hardening.sql
    // (audit M2): claim_tenant_membership atomically promotes the
    // first signup to admin/approved, subsequent signups to the
    // default role with status=pending. The stub mirrors the SQL
    // logic so the test assertions about insertedMembers[0].role
    // continue to verify the behaviour we care about.
    rpc: vi.fn(async (fn, params) => {
      if (fn !== "claim_tenant_membership") {
        return { data: null, error: { message: "unknown rpc " + fn } };
      }
      const existing = memberships.find(
        (m) => m.tenant_id === params.p_tenant_id && m.user_id === params.p_user_id,
      );
      if (existing) {
        return { data: [{ out_tenant_id: existing.tenant_id, out_role: existing.role, out_status: existing.status, out_requested_role: existing.requested_role, out_was_first: false }], error: null };
      }
      const tenantCount = memberships.filter((m) => m.tenant_id === params.p_tenant_id).length;
      const isFirst = tenantCount === 0;
      const role = isFirst ? params.p_first_role : params.p_default_role;
      const status = isFirst || !params.p_require_approval ? "approved" : "pending";
      const row = {
        tenant_id: params.p_tenant_id,
        user_id: params.p_user_id,
        role,
        status,
        requested_role: isFirst ? null : params.p_requested_role,
        request_email: params.p_user_email,
        request_display_name: params.p_display_name,
        request_notes: params.p_notes,
        approved_at: status === "approved" ? new Date().toISOString() : null,
        approved_by: status === "approved" ? params.p_user_id : null,
      };
      memberships.push(row);
      insertedMembers.push(row);
      return { data: [{ out_tenant_id: row.tenant_id, out_role: row.role, out_status: row.status, out_requested_role: row.requested_role, out_was_first: isFirst }], error: null };
    }),
  };
  return stub;
};

describe("ensureMembership", () => {
  beforeEach(() => {
    process.env.AUTO_ONBOARD_TENANT = "true";
  });

  it("returns existing memberships untouched", async () => {
    const memberships = [{ tenant_id: TENANT_ID, user_id: userA.id, role: "admin" }];
    const svc = makeStub({ memberships });
    const result = await ensureMembership(svc, userA);
    expect(result).toEqual(memberships);
    expect(svc._insertedMembers).toEqual([]);
  });

  it("inserts a tenant_members row for a brand new user", async () => {
    const svc = makeStub({ memberships: [] });
    const result = await ensureMembership(svc, userA);
    expect(svc._insertedMembers).toHaveLength(1);
    expect(svc._insertedMembers[0]).toMatchObject({
      tenant_id: TENANT_ID,
      user_id: userA.id,
    });
    expect(result).toHaveLength(1);
  });

  it("makes the very first user an admin", async () => {
    const svc = makeStub({ memberships: [] });
    await ensureMembership(svc, userA);
    expect(svc._insertedMembers[0].role).toBe("admin");
  });

  it("makes subsequent users sales_engineer", async () => {
    const memberships = [{ tenant_id: TENANT_ID, user_id: userA.id, role: "admin" }];
    const svc = makeStub({ memberships });
    await ensureMembership(svc, userB);
    expect(svc._insertedMembers).toHaveLength(1);
    expect(svc._insertedMembers[0].role).toBe("sales_engineer");
  });

  it("seeds the default tenant if missing", async () => {
    const svc = makeStub({ memberships: [], tenants: [] });
    await ensureMembership(svc, userA);
    expect(svc._insertedTenants).toHaveLength(1);
    expect(svc._insertedTenants[0]).toMatchObject({ id: TENANT_ID, slug: "default" });
  });
});
