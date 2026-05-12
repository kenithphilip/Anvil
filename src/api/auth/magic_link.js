// POST /api/auth/magic_link
// Body: { email, redirectTo? }
// Issues a Supabase magic link via the service role and audits the request.
//
// Hardened May 2026 (security audit H2 + M7):
//
//   - redirectTo is allowlisted against the configured
//     MAGIC_LINK_REDIRECT_URL origin. An attacker who triggers a
//     magic link on a victim's email cannot redirect the post-auth
//     landing to attacker.com to harvest the token.
//   - The endpoint responds with the same 200 / generic body whether
//     the email exists, the OTP send succeeded, or the request was
//     rate-limited. This prevents user enumeration and timing oracles.
//   - Per-email + per-IP sliding-window rate limit (5 per 15 min).
//     Audit row records every attempt for forensic review.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { checkRateLimit, recordRateLimitAttempt } from "../_lib/rate-limit.js";

const DEFAULT_REDIRECT = process.env.MAGIC_LINK_REDIRECT_URL || "";

const safeRedirectTo = (caller) => {
  if (!caller) return DEFAULT_REDIRECT || undefined;
  if (!DEFAULT_REDIRECT) return undefined;
  try {
    const u = new URL(caller);
    const base = new URL(DEFAULT_REDIRECT);
    if (u.origin === base.origin) return caller;
  } catch (_) { /* fall through */ }
  return DEFAULT_REDIRECT;
};

// Resolve the user's tenant from email. Magic-link requests
// are pre-auth so there is no JWT claim; we look up auth.users
// by email and pick the user's first tenant_members row. Returns
// null when the email is not associated with any tenant; the
// caller skips the audit insert in that case (migration 111
// enforces tenant_id NOT NULL).
const resolveTenantForEmail = async (svc, email) => {
  try {
    const lower = String(email || "").trim().toLowerCase();
    if (!lower) return null;
    const { data: users } = await svc.auth.admin.listUsers({
      filter: 'email.eq."' + lower + '"',
      page: 1,
      perPage: 1,
    });
    const user = users?.users?.[0];
    if (!user) return null;
    const r = await svc
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return r.data?.tenant_id || null;
  } catch (_) {
    return null;
  }
};

const recordMagicLink = async (svc, email, outcome, ip, ua) => {
  try {
    // Phase 1 F2: tenant_id is now NOT NULL. Resolve the user's
    // tenant before insert; skip the audit row when the email is
    // not tied to a tenant (an attacker spraying random emails
    // generates no rows, which matches the security intent of
    // shouldCreateUser=false on the magic-link send below).
    const tenantId = await resolveTenantForEmail(svc, email);
    if (!tenantId) return;
    await svc.from("auth_magic_links").insert({
      tenant_id: tenantId,
      email: String(email || "").toLowerCase(),
      outcome,
      ip: ip || null,
      user_agent: ua || null,
    });
  } catch (_) {}
};

const ipFromReq = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
};

// Identical response on every code path. Callers can never tell
// whether the email existed or the send succeeded.
const GENERIC_OK = { ok: true, message: "If an account exists for that address, a magic link has been sent." };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    const email = String(body && body.email || "").trim().toLowerCase();
    // Validate email format but never differentiate the response.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(res, 200, GENERIC_OK);
    }
    const redirectTo = safeRedirectTo(String(body?.redirectTo || "").trim());
    const svc = serviceClient();
    const ip = ipFromReq(req);
    const ua = req.headers["user-agent"] || null;

    // Per-email + per-IP rate limit, sliding window.
    const emailRate = await checkRateLimit(svc, "magic_link_attempts", "email:" + email, { maxAttempts: 5, windowMs: 15 * 60 * 1000 });
    const ipRate = ip
      ? await checkRateLimit(svc, "magic_link_attempts", "ip:" + ip, { maxAttempts: 20, windowMs: 15 * 60 * 1000 })
      : { allowed: true };
    if (!emailRate.allowed || !ipRate.allowed) {
      await recordMagicLink(svc, email, "throttled", ip, ua);
      return json(res, 200, GENERIC_OK);
    }
    await recordRateLimitAttempt(svc, "magic_link_attempts", "email:" + email);
    if (ip) await recordRateLimitAttempt(svc, "magic_link_attempts", "ip:" + ip);

    // Audit P1.3 (May 2026): shouldCreateUser was true, which let
    // anyone create accounts in auth.users by spraying magic-link
    // requests across an email list. Combined with the per-email
    // 5-per-15min limit (~480/day), an attacker could fill the
    // auth.users table, inflate the listUsers count, force tenants
    // out of seat plans, and break the signup duplicate check.
    // Signup is a separate explicit path (/api/auth/signup); magic
    // link is sign-in only, never user creation. The generic 200
    // response above hides the "no such user" case from callers.
    const result = await svc.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    });
    if (result.error) {
      await recordMagicLink(svc, email, "failed", ip, ua);
      // Audit M7: never differentiate the response.
      return json(res, 200, GENERIC_OK);
    }
    await recordMagicLink(svc, email, "sent", ip, ua);
    return json(res, 200, GENERIC_OK);
  } catch (err) {
    sendError(res, err);
  }
}
