// POST /api/auth/passkey/register/finish
//
// Step 2 of WebAuthn registration. Browser POSTs the
// AuthenticatorAttestationResponse + the pending_id from /begin.
// We verify the attestation against the stored challenge hash,
// extract the credential public key + counter, and persist a real
// passkey row in place of the placeholder.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { safeAwait } from "../../_lib/safe-thenable.js";
import { PASSKEY_ALG_IDS } from "./register_begin.js";
import crypto from "node:crypto";

const rpIdFromOrigin = () => {
  const origin = process.env.APP_URL || "http://localhost:5173";
  try { return new URL(origin).hostname; } catch (_) { return "localhost"; }
};
const expectedOrigin = () => process.env.APP_URL || "http://localhost:5173";
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    if (!ctx.user?.id) return json(res, 401, { error: { message: "auth required" } });
    const body = await readBody(req);
    const pendingId = String(body?.pending_id || "");
    const response = body?.response;
    if (!pendingId || !response) {
      return json(res, 400, { error: { message: "pending_id and response required" } });
    }

    const svc = serviceClient();
    const { data: pending } = await svc.from("user_passkeys")
      .select("*")
      .eq("credential_id", pendingId)
      .eq("user_id", ctx.user.id)
      .maybeSingle();
    if (!pending || !pending.pending_challenge_hash) {
      return json(res, 400, { error: { message: "No pending registration. Restart the flow." } });
    }
    if (new Date(pending.pending_challenge_expires_at) < new Date()) {
      await svc.from("user_passkeys").delete().eq("credential_id", pendingId);
      return json(res, 400, { error: { code: "CHALLENGE_EXPIRED", message: "Registration timed out. Restart the flow." } });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) => sha256Hex(challenge) === pending.pending_challenge_hash,
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpIdFromOrigin(),
      // Hardened May 2026 (security audit M1). Was false: a roaming
      // hardware key without PIN could register. Now requires the
      // authenticator to actually perform UV (biometric or PIN) so
      // the credential is phishing-resistant from day 1.
      requireUserVerification: true,
      supportedAlgorithmIDs: PASSKEY_ALG_IDS,
    });

    if (!verification.verified || !verification.registrationInfo) {
      await svc.from("user_passkeys").delete().eq("credential_id", pendingId);
      return json(res, 400, { error: { code: "VERIFY_FAILED", message: "Could not verify registration." } });
    }

    // Since @simplewebauthn/server v11 the new credential is
    // registrationInfo.credential = { id, publicKey, counter, transports }.
    // id is already a base64url string; publicKey is the COSE key bytes,
    // stored as base64 and opaque to us (any algorithm fits). This read
    // the v10 fields credentialID / credentialPublicKey, which v11
    // removed, so every registration threw after a good verify.
    const info = verification.registrationInfo;
    const credential = info.credential;
    const credentialIdB64 = credential.id;
    const publicKeyB64 = Buffer.from(credential.publicKey).toString("base64");

    // Replace the placeholder row with the real credential.
    await svc.from("user_passkeys").delete().eq("credential_id", pendingId);
    await svc.from("user_passkeys").insert({
      user_id: ctx.user.id,
      credential_id: credentialIdB64,
      public_key: publicKeyB64,
      counter: credential.counter || 0,
      transports: credential.transports || response.response?.transports || [],
      label: pending.label || "Passkey",
      backup_eligible: info.credentialBackedUp || false,
      backup_state: info.credentialBackedUp || false,
      device_type: info.credentialDeviceType || null,
      last_used_at: new Date().toISOString(),
    });

    // Mirror onto user_security_settings so the bell + signup gate
    // can short-circuit without joining.
    await svc.from("user_security_settings").upsert({
      user_id: ctx.user.id,
      passkey_enrolled: true,
      require_mfa: true,
      last_security_change_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    await safeAwait(svc.from("user_security_audit").insert({
      user_id: ctx.user.id,
      user_email: ctx.user.email,
      event: "passkey_registered",
      detail: { label: pending.label, device: info.credentialDeviceType },
    }));

    return json(res, 200, { ok: true, credential_id: credentialIdB64 });
  } catch (err) {
    return sendError(res, err);
  }
}
