// Tenant onboarding helper.
//
// Why this exists: the auth flow used to leave brand-new users without a
// tenant_members row. Every API call then threw 403 "User has no tenant
// membership" and the UI silently rendered zeros. From the user's
// perspective, signing in BROKE the app, because the anonymous fallback
// (ALLOW_ANONYMOUS_TENANT) at least mapped to the default tenant.
//
// `ensureMembership` makes the membership idempotent: on first call for
// a new user it inserts a row in tenant_members against the default
// tenant. The first user to ever sign in becomes the tenant admin; every
// subsequent user gets the configured default role.
//
// Both auth/verify.js (immediately after the user clicks the magic link)
// and _lib/auth.js (resolveContext fallback for users who signed in
// before this fix shipped) call this helper.

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
const NEW_USER_ROLE = process.env.NEW_USER_ROLE || "sales_engineer";
const FIRST_USER_ROLE = process.env.FIRST_USER_ROLE || "admin";
const AUTO_ONBOARD = String(process.env.AUTO_ONBOARD_TENANT || "true").toLowerCase() === "true";
// Approval-gated signup. Default: ON (production-safe). When false,
// a brand-new user is created with status='approved' immediately,
// preserving the legacy zero-friction dev flow. The first user on
// a fresh tenant always becomes admin + approved regardless of
// this flag, so an empty deployment isn't bricked.
const REQUIRE_APPROVAL = String(process.env.REQUIRE_APPROVAL ?? "true").toLowerCase() === "true";

const VALID_ROLES = new Set([
  "viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin",
]);

const safeRole = (role, fallback) => (VALID_ROLES.has(role) ? role : fallback);

export const isAutoOnboardEnabled = () => AUTO_ONBOARD;

export const requiresApproval = () => REQUIRE_APPROVAL;

export const defaultTenantId = () => DEFAULT_TENANT;

// Returns the user's memberships, inserting one if none exist and
// auto-onboarding is enabled. The returned array always contains at
// least one row when AUTO_ONBOARD is true.
export const ensureMembership = async (svc, user, opts = {}) => {
  if (!user || !user.id) {
    const err = new Error("ensureMembership requires a user with an id");
    err.status = 400;
    throw err;
  }

  const existing = await svc
    .from("tenant_members")
    .select("tenant_id, role, status, requested_role")
    .eq("user_id", user.id);
  if (existing.error) {
    const err = new Error("tenant_members lookup failed: " + existing.error.message);
    err.status = 500;
    throw err;
  }
  if (Array.isArray(existing.data) && existing.data.length > 0) {
    return existing.data;
  }

  if (!AUTO_ONBOARD) {
    return [];
  }

  // Make sure the default tenant row exists. The 001_init.sql migration
  // already inserts it, but a fresh dev DB or a renamed tenant could
  // have removed it; we want the onboard to be self-healing.
  const tenantRow = await svc
    .from("tenants")
    .select("id")
    .eq("id", DEFAULT_TENANT)
    .maybeSingle();
  if (tenantRow.error && tenantRow.error.code !== "PGRST116") {
    const err = new Error("default tenant lookup failed: " + tenantRow.error.message);
    err.status = 500;
    throw err;
  }
  if (!tenantRow.data) {
    const seed = await svc
      .from("tenants")
      .insert({ id: DEFAULT_TENANT, slug: "default", display_name: "Default" })
      .select("id");
    if (seed.error && seed.error.code !== "23505") {
      // 23505 = unique_violation, race with another concurrent request.
      const err = new Error("default tenant seed failed: " + seed.error.message);
      err.status = 500;
      throw err;
    }
  }

  // M2 (May 2026): atomic first-user-admin via a Postgres function
  // that takes a per-tenant advisory lock before counting + inserting.
  // This eliminates the count-then-insert TOCTOU race where two
  // concurrent signups on a fresh tenant could both observe count=0
  // and both insert as admin.
  const meta = user.user_metadata || {};
  const requestedRoleHint = safeRole(
    (opts && opts.requested_role) || meta.requested_role,
    NEW_USER_ROLE,
  );
  const rpc = await svc.rpc("claim_tenant_membership", {
    p_tenant_id: DEFAULT_TENANT,
    p_user_id: user.id,
    p_user_email: user.email || null,
    p_default_role: safeRole(NEW_USER_ROLE, "sales_engineer"),
    p_first_role: safeRole(FIRST_USER_ROLE, "admin"),
    p_requested_role: requestedRoleHint,
    p_display_name: meta.name || meta.full_name || (opts && opts.display_name) || null,
    p_notes: (opts && opts.notes) || null,
    p_require_approval: !!REQUIRE_APPROVAL,
  });
  if (rpc.error) {
    const err = new Error("claim_tenant_membership failed: " + rpc.error.message);
    err.status = 500;
    throw err;
  }
  // The RPC returns one row { out_tenant_id, out_role, out_status,
  // out_requested_role, out_was_first }. Re-shape to the existing
  // contract so callers don't have to change.
  const rows = Array.isArray(rpc.data) ? rpc.data : (rpc.data ? [rpc.data] : []);
  return rows.map((r) => ({
    tenant_id: r.out_tenant_id,
    role: r.out_role,
    status: r.out_status,
    requested_role: r.out_requested_role,
  }));
};

// Fetch tenant admins. Used by /api/auth/signup to know who to
// notify when a new user requests access. Returns an array of
// { user_id, email, display_name } objects. Service-role context
// expected.
export const listTenantAdmins = async (svc, tenantId) => {
  const { data: members } = await svc
    .from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("role", "admin")
    .eq("status", "approved");
  const ids = (members || []).map((m) => m.user_id);
  if (!ids.length) return [];
  const { data: users } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const byId = new Map((users?.users || []).map((u) => [u.id, u]));
  return ids.map((id) => {
    const u = byId.get(id) || {};
    return {
      user_id: id,
      email: u.email || null,
      display_name: u.user_metadata?.name || u.user_metadata?.full_name || null,
    };
  });
};

// Read the approval status for a user at a tenant. Returns a
// status string ('pending'|'approved'|'denied'|'deactivated') or
// null if no membership exists.
export const getMemberStatus = async (svc, userId, tenantId) => {
  const { data, error } = await svc
    .from("tenant_members")
    .select("status, role, denied_reason")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId || DEFAULT_TENANT)
    .maybeSingle();
  if (error || !data) return null;
  return data;
};
