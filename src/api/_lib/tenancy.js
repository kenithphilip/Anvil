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

  // First user wins admin; everyone else gets the configured default
  // role. We count via head:true so we don't pull rows.
  const memberCount = await svc
    .from("tenant_members")
    .select("user_id", { count: "exact", head: true })
    .eq("tenant_id", DEFAULT_TENANT);
  const isFirst = !memberCount.error && (memberCount.count || 0) === 0;
  const role = isFirst ? safeRole(FIRST_USER_ROLE, "admin") : safeRole(NEW_USER_ROLE, "sales_engineer");

  // Approval gate. The first user on the tenant always lands
  // approved (otherwise nobody could ever approve them). Every
  // subsequent user lands pending unless approval is disabled.
  const status = (isFirst || !REQUIRE_APPROVAL) ? "approved" : "pending";
  const meta = user.user_metadata || {};
  const requestedRoleHint = (opts && opts.requested_role) || meta.requested_role;
  const requested_role = isFirst ? null : safeRole(requestedRoleHint, NEW_USER_ROLE);
  const insertRow = {
    tenant_id: DEFAULT_TENANT,
    user_id: user.id,
    role,
    status,
    requested_role,
    requested_at: new Date().toISOString(),
    request_email: user.email || null,
    request_display_name: meta.name || meta.full_name || (opts && opts.display_name) || null,
    request_notes: (opts && opts.notes) || null,
  };
  if (status === "approved") {
    insertRow.approved_at = new Date().toISOString();
    insertRow.approved_by = user.id;                   // self-approval for the first user
  }
  const inserted = await svc
    .from("tenant_members")
    .insert(insertRow)
    .select("tenant_id, role, status, requested_role");
  if (inserted.error) {
    // Race: another request from the same user inserted concurrently.
    // Re-read and return whatever's there.
    if (inserted.error.code === "23505") {
      const retry = await svc
        .from("tenant_members")
        .select("tenant_id, role")
        .eq("user_id", user.id);
      return retry.data || [];
    }
    const err = new Error("tenant_members insert failed: " + inserted.error.message);
    err.status = 500;
    throw err;
  }
  return inserted.data || [];
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
