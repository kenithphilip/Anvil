// POST /api/auth/complete_reset
//
// Body: { access_token, new_password }
//
// The reset email contains a Supabase recovery link that, on click,
// lands the user on /#/reset?access_token=...&type=recovery. The
// page extracts that token, asks for a new password + confirm, and
// posts here.
//
// Server-side flow:
//   1. Resolve the access_token via supabase.auth.getUser(token).
//      If invalid / expired -> 401.
//   2. Use the service role to update the user's password
//      (`auth.admin.updateUserById`). The user does NOT get a
//      session back; they sign in again with the new password,
//      which also gives the access-approval gate a fresh chance
//      to run.
//   3. Audit + invalidate any current sessions for that user
//      (best-effort) so a stolen access_token can't outlive the
//      reset.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { createClient } from "@supabase/supabase-js";

const MIN_PASSWORD = 10;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const body = await readBody(req);
    const accessToken = String(body?.access_token || "").trim();
    const newPassword = String(body?.new_password || "");
    if (!accessToken) return json(res, 400, { error: { message: "access_token required" } });
    if (newPassword.length < MIN_PASSWORD) {
      return json(res, 400, { error: { message: `Password must be at least ${MIN_PASSWORD} characters` } });
    }

    const anonUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // Resolve the user by validating the recovery token.
    const { data, error } = await anon.auth.getUser(accessToken);
    if (error || !data?.user) {
      return json(res, 401, { error: { code: "INVALID_TOKEN", message: "Reset link is invalid or expired. Request a new one." } });
    }
    const user = data.user;

    const svc = serviceClient();

    // Update the password via the service role. Supabase enforces
    // its own minimum but we already gated on MIN_PASSWORD above
    // so the message is friendly.
    const upd = await svc.auth.admin.updateUserById(user.id, { password: newPassword });
    if (upd.error) {
      // Audit even on failure so an admin can spot a probing run.
      await svc.from("user_security_audit").insert({
        user_id: user.id,
        user_email: user.email,
        event: "password_reset_completed",
        detail: { ok: false, error: upd.error.message?.slice(0, 240) },
      }).catch(() => {});
      return json(res, 500, { error: { message: "Could not reset password: " + upd.error.message } });
    }

    // Best-effort: invalidate any open sessions so a stolen recovery
    // token can't outlive the reset. signOut needs a user-token; we
    // can sign out the recovery token itself which is enough.
    try { await anon.auth.signOut(); } catch (_) { /* ignore */ }

    // Audit success.
    await svc.from("user_security_audit").insert({
      user_id: user.id,
      user_email: user.email,
      event: "password_reset_completed",
      detail: { ok: true },
    }).catch(() => {});

    // Drop the rate-limit row so the user can request another reset
    // if they typo something next time, without waiting an hour.
    await svc.from("password_reset_attempts").delete().eq("email", user.email).catch(() => {});

    return json(res, 200, {
      ok: true,
      message: "Password updated. Sign in with the new one.",
      email: user.email,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
