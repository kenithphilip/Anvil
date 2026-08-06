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
const VIEWER_ROLES   = new Set(["viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "design_engineer", "design_manager", "customer_support"]);
// customer_support is read-only server-side (it inherits the viewer matrix on
// the client). Its ONE write — sharing a spare matrix to the customer portal —
// is gated by the "spare_matrix.share" action (requireAction) rather than
// blanket WRITER_ROLES membership, so it can no longer write to every other
// endpoint (invoices, customers, quotes, …).
const WRITER_ROLES   = new Set(["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "design_engineer", "design_manager"]);
const APPROVER_ROLES = new Set(["sales_manager", "finance", "admin"]);
const ADMIN_ROLES    = new Set(["admin"]);

const REQUIRED_ROLES = {
  read: VIEWER_ROLES,
  write: WRITER_ROLES,
  approve: APPROVER_ROLES,
  admin: ADMIN_ROLES,
};

// ── Per-tenant domain mapping (Phase 0) ──────────────────────────────────
// Resolve the request Host to a tenant, so a per-tenant domain/subdomain
// (e.g. obara.anvil.app, or a custom vanity host) can scope the session
// without the user typing a tenant UUID. Ships DARK: used only as a fallback
// in resolveContext when no x-anvil-tenant header is present AND the resolved
// tenant is one the user already belongs to — it never grants cross-tenant
// access. See docs / PR: tenant domain mapping Phase 0.

// The effective request host, lowercased, port stripped. Prefers the
// x-forwarded-host the proxy (Vercel) sets over the raw Host header.
export const hostFromReq = (req) => {
  const raw = String((req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "")
    .split(",")[0].trim().toLowerCase();
  return raw.replace(/:\d+$/, "");
};

// The leftmost subdomain label of a host, or "" when there isn't one (apex
// domain, bare hostname, localhost, or an IP literal). Maps
// <slug>.<app-domain> to a tenant by slug.
export const subdomainLabel = (host) => {
  const h = String(host || "").trim().toLowerCase();
  if (!h || h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return "";
  const parts = h.split(".");
  if (parts.length < 3) return "";   // need sub.domain.tld to have a subdomain
  return parts[0];
};

// Look up the tenant a host maps to: first an explicit full-host `domain`
// match (custom vanity domains), then the subdomain label against `slug`.
// Best-effort — any error resolves to null so host resolution can never break
// auth; the caller then falls back to the user's default tenant.
export const resolveHostTenant = async (svc, req) => {
  try {
    const host = hostFromReq(req);
    if (!host) return null;
    const byDomain = await svc.from("tenants").select("id").ilike("domain", host).maybeSingle();
    if (byDomain && byDomain.data && byDomain.data.id) return byDomain.data.id;
    const label = subdomainLabel(host);
    if (!label) return null;
    const bySlug = await svc.from("tenants").select("id").eq("slug", label).maybeSingle();
    return (bySlug && bySlug.data && bySlug.data.id) || null;
  } catch (_) {
    return null;
  }
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
  // Tenant precedence: explicit x-anvil-tenant header > per-tenant host
  // (domain/subdomain) the user belongs to > the user's first membership.
  // Host resolution can NEVER select a tenant the user isn't a member of —
  // an unknown or non-member host simply falls through to allowed[0], so this
  // is backward-compatible and ships dark until a tenant domain is populated.
  let tenantId = tenantHeader;
  if (!tenantId) {
    const hostTenant = await resolveHostTenant(svc, req);
    if (hostTenant && allowed.some((m) => m.tenant_id === hostTenant)) tenantId = hostTenant;
  }
  if (!tenantId) tenantId = allowed[0].tenant_id;
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

// ── Fine-grained action gating ───────────────────────────────────────────
// The coarse read/write/approve/admin verbs above are too broad for a handful
// of sensitive actions: the client ACTIONS matrix (src/v3-app/lib/rbac.ts) and
// the per-resource MATRIX restrict them further, but until now that was
// enforced ONLY client-side. SERVER_ACTIONS mirrors the sensitive entries so the
// server is the real gate. Enforced at the specific endpoints (share, invoices,
// quotes convert/send, customer GSTIN). Kept in sync with rbac.ts by
// src/scripts/audit-rbac.mjs.
export const SERVER_ACTIONS = {
  // Share a spare matrix to the customer portal — the ONE write customer_support
  // is allowed (it is otherwise read-only). Mirrors rbac.ts ACTIONS.
  "spare_matrix.share":  new Set(["sales_engineer", "sales_manager", "design_engineer", "design_manager", "customer_support", "admin"]),
  // GSTIN edits are restricted (a bad GSTIN breaks e-invoice IRN / Tally lookup).
  "customer.edit_gstin": new Set(["sales_manager", "admin"]),
  // MATRIX.invoices: only sales_manager (rw), finance (rwa), admin (rwa) — NOT
  // operator/procurement/customer_support/sales_engineer (r or hidden).
  "invoices.write":      new Set(["sales_manager", "finance", "admin"]),
  // MATRIX.quotes: sales_manager (rwa) + admin (rwa) approve/convert/send;
  // finance is read-only on quotes (its approve power is invoices/tally).
  "quotes.approve":      new Set(["sales_manager", "admin"]),
};

export const hasAction = (ctx, action) => {
  const allow = SERVER_ACTIONS[action];
  if (!allow) return true;                 // action not server-gated here
  if (!ctx || ctx.anonymous) return false; // anonymous can never act
  return allow.has(ctx.role) || ctx.role === "admin";
};

// Throwing gate for a fine-grained action. Call AFTER requirePermission (which
// enforces the coarse verb + the anonymous hard-stop) so this only tightens.
export const requireAction = (ctx, action) => {
  if (!hasAction(ctx, action)) {
    const err = new Error("Role " + (ctx && ctx.role) + " is not permitted to perform '" + action + "'");
    err.status = 403;
    err.code = "ACTION_FORBIDDEN";
    throw err;
  }
};
