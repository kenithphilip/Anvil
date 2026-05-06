// POST /api/auth/password_login
//
// Body: { email, password }
//
// Email + password sign-in for accounts that opted out of magic link.
// The browser cannot call signInWithPassword directly without the
// SUPABASE_ANON_KEY in the bundle (which is fine but requires
// frontend plumbing); proxying through this endpoint keeps the anon
// key server-side and gives us a single audit point.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { ensureMembership, getMemberStatus, defaultTenantId } from "../_lib/tenancy.js";
import { decryptField } from "../_lib/secrets.js";
import { verifyTotpAndConsume } from "../_lib/totp.js";
import { checkRateLimit, recordRateLimitAttempt } from "../_lib/rate-limit.js";
import { createClient } from "@supabase/supabase-js";
import { safeAwait } from "../_lib/safe-thenable.js";

const readActiveTotpSecret = (row) => {
  if (!row) return null;
  if (row.totp_secret_enc && row.totp_secret_iv) {
    try { return decryptField(row.totp_secret_enc, row.totp_secret_iv); }
    catch (_) { return row.totp_secret || null; }
  }
  return row.totp_secret || null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!email || !password) return json(res, 400, { error: { message: "email and password required" } });

    const anonUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const session = await anon.auth.signInWithPassword({ email, password });
    if (session.error) {
      const status = /credentials/i.test(session.error.message) ? 401 : 500;
      return json(res, status, { error: { message: session.error.message } });
    }
    const user = session.data?.user;
    if (!user) return json(res, 500, { error: { message: "Sign-in returned no user" } });

    // Recovery for legacy users who signed up before auto-onboarding.
    const svc = serviceClient();
    await ensureMembership(svc, user);

    // MFA gate. If the user has TOTP enrolled, the password alone is
    // not enough: we require a fresh code from their authenticator.
    // - If no totp_code in the body, return 200 with mfa_required:true
    //   and DO NOT issue the session. The client switches to the
    //   TOTP entry view.
    // - If totp_code is provided, validate with the same skew window
    //   the enroll path uses. Wrong code -> 401. Right code -> drop
    //   through to the existing approval gate + session mint.
    const { data: secRow } = await svc.from("user_security_settings")
      .select("totp_enrolled, totp_secret_enc, totp_secret, totp_secret_iv")
      .eq("user_id", user.id).maybeSingle();
    if (secRow?.totp_enrolled) {
      const totpCode = String(body?.totp_code || "").replace(/\D/g, "");
      if (!totpCode) {
        // Best-effort: sign out the freshly-minted session so the
        // access_token can't be used without the second factor.
        try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
        return json(res, 200, {
          mfa_required: true,
          email: user.email,
        });
      }
      // Rate limit + replay protection (audit M3 + H1, May 2026).
      // 5 failed login-MFA attempts per user per 15 minutes. The
      // ledger insert inside verifyTotpAndConsume rejects replays
      // even within a single 30-second window.
      const rate = await checkRateLimit(svc, "mfa_attempts", "login:" + user.id, { maxAttempts: 5, windowMs: 15 * 60 * 1000 });
      if (!rate.allowed) {
        try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
        return json(res, 429, { error: { code: "RATE_LIMITED", message: "Too many failed attempts. Try again in " + rate.retry_in_sec + " seconds." } });
      }
      const secret = readActiveTotpSecret(secRow);
      const verifyRes = secret
        ? await verifyTotpAndConsume(svc, user.id, secret, totpCode)
        : { valid: false };
      if (!verifyRes.valid) {
        try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
        await recordRateLimitAttempt(svc, "mfa_attempts", "login:" + user.id);
        await safeAwait(svc.from("user_security_audit").insert({
          user_id: user.id,
          user_email: user.email,
          event: "mfa_challenge_fail",
          detail: { phase: "login", replayed: !!verifyRes.replayed },
        }));
        const message = verifyRes.replayed
          ? "This code has already been used. Wait for the next code from your authenticator."
          : "Two-factor code is incorrect. Try the current code from your authenticator.";
        return json(res, 401, {
          error: {
            code: verifyRes.replayed ? "TOTP_REPLAY" : "INVALID_TOTP",
            message,
          },
        });
      }
      await safeAwait(svc.from("user_security_audit").insert({
        user_id: user.id,
        user_email: user.email,
        event: "mfa_challenge_ok",
        detail: { phase: "login" },
      }));
    }

    // APPROVAL GATE.
    //
    // The Supabase password sign-in succeeded, which means the
    // account exists. But access to Anvil also requires an approved
    // tenant membership. If the user is pending / denied /
    // deactivated, we refuse to return the session and immediately
    // sign them out so the access_token isn't usable. The frontend
    // shows a friendly screen keyed by the `status` code below.
    const membership = await getMemberStatus(svc, user.id, defaultTenantId());
    if (membership && membership.status && membership.status !== "approved") {
      // Best-effort sign-out so the token can't be replayed. We
      // don't fail the response on signOut errors because the token
      // expires fast anyway and we'll refuse it on the next call
      // via the resolveContext gate.
      try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
      const friendly = membership.status === "pending"
        ? "Your account is pending admin approval. You'll be able to sign in once an admin approves your access request."
        : membership.status === "denied"
        ? "Your access request was denied" + (membership.denied_reason ? (": " + membership.denied_reason) : ".")
        : "Your account has been deactivated. Contact your tenant admin.";
      return json(res, 403, {
        error: {
          code: "MEMBERSHIP_" + String(membership.status).toUpperCase(),
          message: friendly,
          status: membership.status,
        },
      });
    }

    return json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.user_metadata?.name || user.user_metadata?.full_name || null,
      },
      session: {
        access_token: session.data.session?.access_token || null,
        refresh_token: session.data.session?.refresh_token || null,
        expires_at: session.data.session?.expires_at || null,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}
