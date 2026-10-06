// Customer-portal authentication (v1). Segregated from internal staff auth
// (src/api/_lib/auth.js): a portal identity lives in portal_users, is scoped to
// ONE customer, and never carries an internal role.
//
// resolveCustomerContext validates a Supabase Bearer JWT (the SAME session shape
// Supabase issues for password login today AND for SSO later — so this works
// unchanged when SSO is added) and resolves the portal_users row. A JWT with no
// portal_users row is rejected, so an internal-staff token can't reach portal
// data and vice-versa.

import { serviceClient, userClient } from "./supabase.js";

// The read scopes a logged-in portal user has over THEIR OWN customer's data.
//
// This tracks what the portal CLIENT can display, not what the API can serve.
// It used to grant summary/quotes/orders/invoices as well — four kinds the
// shipped portal never calls. PortalHome makes exactly two view() requests,
// for "spares" and "spare_matrix", and there is no other portal client; the
// rest was authenticated surface with nothing behind it, serving order and
// invoice rows to a session that had no way to render them.
//
// A scope is a grant, so the default should be the smallest one that makes the
// product work. Build the invoices tab and add "invoices" back in the same
// commit — api-portal-scope-surface.test.js fails either way round, so the two
// cannot drift apart again.
//
// Note "spares" also covers the spare_matrix kind: view.js maps
// spare_matrix -> the spares scope. And "summary" was never a scope at all —
// that kind requires "quotes" — so listing it here granted nothing and read
// as though it did.
//
// Legacy shared tokens are untouched: their scopes were granted explicitly per
// token and are none of this constant's business.
export const SESSION_SCOPES = ["spares"];

export const resolveCustomerContext = async (req) => {
  const headerAuth = (req.headers.authorization || req.headers.Authorization || "").trim();
  if (!headerAuth) { const e = new Error("Missing Authorization header"); e.status = 401; throw e; }
  const token = headerAuth.replace(/^Bearer\s+/i, "");
  const supa = userClient(token);
  const { data, error } = await supa.auth.getUser();
  if (error || !data || !data.user) { const e = new Error("Invalid session"); e.status = 401; throw e; }

  const svc = serviceClient();
  const pu = await svc.from("portal_users")
    .select("id, tenant_id, customer_id, role, status, require_mfa, email")
    .eq("auth_user_id", data.user.id).maybeSingle();
  if (pu.error) { const e = new Error(pu.error.message); e.status = 500; throw e; }
  if (!pu.data) { const e = new Error("Not a portal user"); e.status = 403; throw e; }
  if (pu.data.status !== "active") { const e = new Error("Portal account is " + pu.data.status); e.status = 403; throw e; }

  return {
    portalUserId: pu.data.id,
    customerId: pu.data.customer_id,
    tenantId: pu.data.tenant_id,
    role: pu.data.role,
    email: pu.data.email,
    requireMfa: pu.data.require_mfa,
  };
};

// Dual-auth for the portal READ endpoints during the migration off URL tokens.
// Prefers a SESSION (Bearer header — the token is NOT in the URL); falls back to
// a legacy portal_tokens URL/body token. Returns a token-shaped object the
// existing endpoint bodies already consume (tenant_id / customer_id / scopes),
// plus `id` (portal_tokens id or null) and `portal_user_id`.
export const resolvePortalAccess = async (req, svc) => {
  const headerAuth = (req.headers.authorization || req.headers.Authorization || "").trim();
  if (headerAuth) {
    const ctx = await resolveCustomerContext(req);
    return { tenant_id: ctx.tenantId, customer_id: ctx.customerId, scopes: SESSION_SCOPES, id: null, portal_user_id: ctx.portalUserId, via: "session" };
  }
  // Legacy shared token (query string or body).
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch (_) { /* ignore */ }
  if (!token && req._body && req._body.token) token = req._body.token;
  if (!token) { const e = new Error("token required"); e.status = 401; throw e; }
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error) { const e = new Error(r.error.message); e.status = 500; throw e; }
  const t = r.data;
  if (!t) { const e = new Error("token not found"); e.status = 404; throw e; }
  if (t.revoked_at) { const e = new Error("token revoked"); e.status = 401; throw e; }
  if (t.expires_at && new Date(t.expires_at) < new Date()) { const e = new Error("token expired"); e.status = 401; throw e; }
  return { tenant_id: t.tenant_id, customer_id: t.customer_id, scopes: t.scopes || [], id: t.id, portal_user_id: null, via: "token" };
};
