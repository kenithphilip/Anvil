import { serviceClient, userClient } from "./supabase.js";
import { ensureMembership, isAutoOnboardEnabled } from "./tenancy.js";

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
// Hardened May 2026 (security audit C1). Previously defaulted to
// "true", which combined with the wildcard CORS in vercel.json meant
// any unauthenticated cross-origin caller could write business data
// on the default tenant. The default is now "false"; anonymous-write
// is also blocked at requirePermission below regardless of role.
//
// Production deployments must NEVER set this to true. The startup
// guard further down refuses to operate when NODE_ENV=production
// and the flag is on.
const ALLOW_ANONYMOUS = String(process.env.ALLOW_ANONYMOUS_TENANT || "false").toLowerCase() === "true";
const NODE_ENV = process.env.NODE_ENV || "development";
if (ALLOW_ANONYMOUS && NODE_ENV === "production") {
  // Fatal: refuse to import the auth module in this configuration.
  // dispatch.js will fail to start and the deploy will roll back.
  throw new Error(
    "ALLOW_ANONYMOUS_TENANT=true is forbidden in production. " +
    "Unset the env var or set it to false."
  );
}

// Role permission sets. Mirrors the frontend matrix in
// src/v3-app/lib/rbac.ts. Run `node src/scripts/audit-rbac.mjs` to
// confirm consistency.
//
// `operator` was previously missing from VIEWER_ROLES, which meant
// operator-role users (service-visit and AMC handlers) got 403 on
// every read endpoint that asked for "read" permission, despite the
// frontend matrix granting them read across most pages.
const VIEWER_ROLES   = new Set(["viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"]);
const WRITER_ROLES   = new Set(["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"]);
const APPROVER_ROLES = new Set(["sales_manager", "finance", "admin"]);
const ADMIN_ROLES    = new Set(["admin"]);

const REQUIRED_ROLES = {
  read: VIEWER_ROLES,
  write: WRITER_ROLES,
  approve: APPROVER_ROLES,
  admin: ADMIN_ROLES,
};

export const resolveContext = async (req) => {
  const headerAuth = (req.headers.authorization || req.headers.Authorization || "").trim();
  // Primary header is `x-anvil-tenant`; `x-obara-tenant` is accepted as a
  // legacy fallback for in-flight clients + external inbound webhooks.
  const tenantHeader = (req.headers["x-anvil-tenant"] || req.headers["x-obara-tenant"] || "").trim();
  if (!headerAuth) {
    if (!ALLOW_ANONYMOUS) {
      const err = new Error("Missing Authorization header");
      err.status = 401;
      throw err;
    }
    return { user: null, tenantId: tenantHeader || DEFAULT_TENANT, role: "sales_engineer", anonymous: true };
  }
  const token = headerAuth.replace(/^Bearer\s+/i, "");
  const supa = userClient(token);
  const { data, error } = await supa.auth.getUser();
  if (error || !data || !data.user) {
    const err = new Error("Invalid Authorization token");
    err.status = 401;
    throw err;
  }
  const user = data.user;
  const svc = serviceClient();
  let memberships = await svc.from("tenant_members")
    .select("tenant_id, role, status, denied_reason")
    .eq("user_id", user.id);
  if (memberships.error) {
    const err = new Error("Tenant lookup failed: " + memberships.error.message);
    err.status = 500;
    throw err;
  }
  let allowed = memberships.data || [];

  // If the user has no membership yet, auto-onboard them. This catches
  // the case where a user signed in BEFORE auth/verify.js learned to
  // create the row. Without this, every request returned 403 and the
  // UI silently rendered empty arrays.
  if (!allowed.length && isAutoOnboardEnabled()) {
    allowed = await ensureMembership(svc, user);
  }

  if (!allowed.length) {
    const err = new Error("User has no tenant membership");
    err.status = 403;
    throw err;
  }
  const tenantId = tenantHeader || allowed[0].tenant_id;
  const membership = allowed.find((m) => m.tenant_id === tenantId);
  if (!membership) {
    const err = new Error("User is not a member of tenant " + tenantId);
    err.status = 403;
    throw err;
  }
  // Approval gate. A user can have a row but be in pending / denied /
  // deactivated state; in any of those cases we MUST refuse the
  // request, otherwise the UI would happily render data for an
  // un-approved account. We surface a structured error code so the
  // frontend can show a friendly screen instead of a generic 403.
  if (membership.status && membership.status !== "approved") {
    const err = new Error("Membership not approved (status=" + membership.status + ")");
    err.status = 403;
    err.code = "MEMBERSHIP_" + String(membership.status).toUpperCase();
    err.detail = membership.denied_reason || null;
    throw err;
  }
  return { user, tenantId, role: membership.role, anonymous: false };
};

// Non-throwing permission check. Use when a handler needs to branch on
// the caller's level (e.g. allow an approver to override a guardrail)
// rather than hard-fail.
export const hasPermission = (ctx, level) => {
  if (ctx?.anonymous && level !== "read") return false;
  const required = REQUIRED_ROLES[level] || REQUIRED_ROLES.read;
  return required.has(ctx?.role);
};

export const requirePermission = (ctx, level) => {
  // Hard gate: anonymous callers may at most read. Even in dev,
  // never let an unauthenticated caller cross into write/approve/admin.
  // Belt-and-braces with the ALLOW_ANONYMOUS default flip above; this
  // guard is the single line that fails closed if the env var is ever
  // accidentally re-enabled.
  if (ctx.anonymous && level !== "read") {
    const err = new Error("Authentication required for " + level + " actions");
    err.status = 401;
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  const required = REQUIRED_ROLES[level] || REQUIRED_ROLES.read;
  if (!required.has(ctx.role)) {
    const err = new Error("Role " + ctx.role + " is not allowed to perform " + level + " action");
    err.status = 403;
    throw err;
  }
};
