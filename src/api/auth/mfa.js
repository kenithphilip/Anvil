// /api/auth/mfa
//
//   POST { action: "enroll" }            generate + persist a pending TOTP secret,
//                                         return otpauth_uri + secret for QR rendering.
//   POST { action: "verify", code }      validate the TOTP against the pending secret
//                                         and promote it to the active secret;
//                                         flip totp_enrolled + require_mfa.
//   POST { action: "unenroll", code }    require the current TOTP, then clear the
//                                         secret. Refusing to require a code here
//                                         would let a stolen session revoke MFA.
//   GET                                  read the caller's current security settings
//                                         (totp_enrolled, passkey_enrolled,
//                                         require_mfa, last change at).
//
// All routes require an authenticated user. We never expose the
// raw secret to the client after enrollment is confirmed.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { encryptField, decryptField, isSecretsConfigured, newIv } from "../_lib/secrets.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../_lib/totp.js";

const ENROLL_PENDING_TTL_MIN = 10;

const persistSecret = (column, secret) => {
  if (!isSecretsConfigured()) {
    return { [`${column}_enc`]: null, [column]: secret, [`${column}_iv`]: null };
  }
  const iv = newIv();
  return { [`${column}_enc`]: encryptField(secret, iv), [column]: null, [`${column}_iv`]: iv };
};

const readSecret = (row, column) => {
  if (!row) return null;
  if (row[`${column}_enc`] && row[`${column}_iv`]) {
    try { return decryptField(row[`${column}_enc`], row[`${column}_iv`]); }
    catch (_) { return row[column] || null; }
  }
  return row[column] || null;
};

const auditEvent = async (svc, ctx, event, detail = {}) => {
  try {
    await svc.from("user_security_audit").insert({
      user_id: ctx.user?.id,
      user_email: ctx.user?.email,
      event,
      detail,
    });
  } catch (_) { /* best-effort */ }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    if (!ctx.user?.id) return json(res, 401, { error: { message: "auth required" } });
    const svc = serviceClient();

    const { data: existing } = await svc.from("user_security_settings")
      .select("*").eq("user_id", ctx.user.id).maybeSingle();

    if (req.method === "GET") {
      return json(res, 200, {
        totp_enrolled: !!existing?.totp_enrolled,
        passkey_enrolled: !!existing?.passkey_enrolled,
        require_mfa: !!existing?.require_mfa,
        last_security_change_at: existing?.last_security_change_at || null,
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const body = await readBody(req);
    const action = body?.action;

    if (action === "enroll") {
      // Generating a NEW pending secret revokes any prior pending
      // secret on the same row. The active secret is untouched
      // until verify succeeds.
      const secret = generateTotpSecret();
      const enc = persistSecret("totp_pending_secret", secret);
      const expiresAt = new Date(Date.now() + ENROLL_PENDING_TTL_MIN * 60_000).toISOString();
      const row = {
        user_id: ctx.user.id,
        ...enc,
        totp_pending_expires_at: expiresAt,
        last_security_change_at: new Date().toISOString(),
      };
      if (existing) {
        await svc.from("user_security_settings").update(row).eq("user_id", ctx.user.id);
      } else {
        await svc.from("user_security_settings").insert(row);
      }
      const uri = otpauthUri({ secret, issuer: "Anvil", account: ctx.user.email });
      return json(res, 200, {
        secret,                                    // text fallback for users who can't scan
        otpauth_uri: uri,                          // for QR rendering on the client
        expires_at: expiresAt,
      });
    }

    if (action === "verify") {
      // Promote the pending secret to active when the supplied
      // code matches. If the pending secret is expired (>10m),
      // force the user to start over.
      const code = String(body?.code || "").replace(/\D/g, "");
      if (!code) return json(res, 400, { error: { message: "code required" } });
      if (!existing?.totp_pending_expires_at || new Date(existing.totp_pending_expires_at) < new Date()) {
        return json(res, 400, { error: { code: "ENROLL_EXPIRED", message: "Enrollment expired. Restart the setup flow." } });
      }
      const pending = readSecret(existing, "totp_pending_secret");
      if (!pending) return json(res, 400, { error: { message: "No pending enrollment. Start over." } });
      if (!verifyTotp(pending, code)) {
        await auditEvent(svc, ctx, "mfa_challenge_fail", { phase: "enroll" });
        return json(res, 401, { error: { code: "INVALID_CODE", message: "Code didn't match. Try the current code from your authenticator." } });
      }
      const activeEnc = persistSecret("totp_secret", pending);
      await svc.from("user_security_settings").update({
        ...activeEnc,
        totp_pending_secret_enc: null,
        totp_pending_secret: null,
        totp_pending_secret_iv: null,
        totp_pending_expires_at: null,
        totp_enrolled: true,
        require_mfa: true,
        last_security_change_at: new Date().toISOString(),
      }).eq("user_id", ctx.user.id);
      await auditEvent(svc, ctx, "mfa_enrolled", { method: "totp" });
      return json(res, 200, { ok: true, totp_enrolled: true });
    }

    if (action === "unenroll") {
      // To unenroll, the user MUST present a valid TOTP code. This
      // prevents a stolen session from disabling MFA without the
      // legitimate authenticator.
      const code = String(body?.code || "").replace(/\D/g, "");
      if (!existing?.totp_enrolled) {
        return json(res, 400, { error: { message: "TOTP is not enrolled" } });
      }
      const active = readSecret(existing, "totp_secret");
      if (!active || !code || !verifyTotp(active, code)) {
        await auditEvent(svc, ctx, "mfa_challenge_fail", { phase: "unenroll" });
        return json(res, 401, { error: { code: "INVALID_CODE", message: "Current TOTP code is required to disable MFA." } });
      }
      await svc.from("user_security_settings").update({
        totp_secret_enc: null,
        totp_secret: null,
        totp_secret_iv: null,
        totp_pending_secret_enc: null,
        totp_pending_secret: null,
        totp_pending_secret_iv: null,
        totp_pending_expires_at: null,
        totp_enrolled: false,
        require_mfa: !!existing?.passkey_enrolled,           // keep MFA flag if passkeys are enrolled
        last_security_change_at: new Date().toISOString(),
      }).eq("user_id", ctx.user.id);
      await auditEvent(svc, ctx, "mfa_unenrolled");
      return json(res, 200, { ok: true, totp_enrolled: false });
    }

    return json(res, 400, { error: { message: "Unknown action: " + action } });
  } catch (err) {
    return sendError(res, err);
  }
}
