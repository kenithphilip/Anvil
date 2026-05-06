// POST /api/auth/passkey/auth/finish
//
// Step 2 of WebAuthn sign-in. Browser POSTs the
// AuthenticatorAssertionResponse + the challenge_id. We:
//   1. Verify the assertion against the stored challenge hash and
//      the credential's stored public key.
//   2. Mint a Supabase session for the user via service-role
//      generateLink (recovery type, then auto-resolve).
//   3. Pass through the same approval gate as password_login so
//      pending / denied users still can't get in.
//
// Body: { email, challenge_id, response }

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { ensureMembership, getMemberStatus, defaultTenantId } from "../../_lib/tenancy.js";
import { createClient } from "@supabase/supabase-js";
import { safeAwait } from "../../_lib/safe-thenable.js";
import crypto from "node:crypto";

const rpIdFromOrigin = () => {
  const origin = process.env.APP_URL || "http://localhost:5173";
  try { return new URL(origin).hostname; } catch (_) { return "localhost"; }
};
const expectedOrigin = () => process.env.APP_URL || "http://localhost:5173";
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Mint a Supabase session for a user without their password.
// Generates a magic link and immediately exchanges it.
const mintSessionForUser = async (svc, email) => {
  const { data, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error("generateLink: " + error.message);
  // The action_link contains a token_hash + type. We turn that into
  // a session via verifyOtp using the anon client.
  const link = data?.properties?.action_link;
  if (!link) throw new Error("generateLink returned no link");
  const url = new URL(link);
  const token = url.searchParams.get("token") || url.searchParams.get("token_hash");
  if (!token) throw new Error("generateLink missing token");
  const anonUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
  const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const verify = await anon.auth.verifyOtp({ email, token, type: "magiclink" });
  if (verify.error) throw new Error("verifyOtp: " + verify.error.message);
  return verify.data;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const body = await readBody(req);
    const email = String(body?.email || "").trim().toLowerCase();
    const challengeId = String(body?.challenge_id || "");
    const response = body?.response;
    if (!email || !challengeId || !response) {
      return json(res, 400, { error: { message: "email, challenge_id and response required" } });
    }
    const svc = serviceClient();

    // Resolve the user. Audit follow-up (May 2026, regression of
    // H11): use email-filtered listUsers instead of project-wide
    // pull. Closes a cross-tenant enumeration vector on this
    // pre-authentication endpoint.
    let user = null;
    try {
      const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1, email });
      user = (data?.users || [])[0] || null;
    } catch (_) { user = null; }
    if (!user) {
      return json(res, 401, { error: { code: "PASSKEY_FAIL", message: "Could not verify passkey." } });
    }

    // Pull the pending challenge stashed by /auth_begin.
    const { data: pending } = await svc.from("user_passkeys")
      .select("*")
      .eq("user_id", user.id)
      .eq("credential_id", challengeId)
      .maybeSingle();
    if (!pending || !pending.pending_challenge_hash) {
      return json(res, 401, { error: { code: "CHALLENGE_MISSING", message: "Sign-in challenge expired. Try again." } });
    }
    if (new Date(pending.pending_challenge_expires_at) < new Date()) {
      await svc.from("user_passkeys").delete().eq("credential_id", challengeId);
      return json(res, 401, { error: { code: "CHALLENGE_EXPIRED", message: "Sign-in challenge expired. Try again." } });
    }

    // Find the matching credential by id (the response has the
    // credential id used).
    const credIdB64url = response.id;
    const { data: cred } = await svc.from("user_passkeys")
      .select("id, credential_id, public_key, counter")
      .eq("user_id", user.id)
      .eq("credential_id", credIdB64url)
      .maybeSingle();
    if (!cred) {
      await svc.from("user_passkeys").delete().eq("credential_id", challengeId);
      return json(res, 401, { error: { code: "PASSKEY_FAIL", message: "Unknown passkey." } });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => sha256Hex(challenge) === pending.pending_challenge_hash,
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpIdFromOrigin(),
      authenticator: {
        credentialID: Buffer.from(cred.credential_id, "base64url"),
        credentialPublicKey: Buffer.from(cred.public_key, "base64"),
        counter: Number(cred.counter || 0),
      },
      // Hardened May 2026 (security audit M1). Phishing-resistance
      // is the whole point of passkeys; we require the authenticator
      // to actually perform UV at sign-in time.
      requireUserVerification: true,
    });

    // Always drop the challenge row, success or fail.
    await svc.from("user_passkeys").delete().eq("credential_id", challengeId);

    if (!verification.verified) {
      await safeAwait(svc.from("user_security_audit").insert({
        user_id: user.id, user_email: email,
        event: "passkey_login_fail",
      }));
      return json(res, 401, { error: { code: "PASSKEY_FAIL", message: "Could not verify passkey." } });
    }

    // Bump the counter to detect cloned credentials on the next login.
    await svc.from("user_passkeys").update({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    }).eq("id", cred.id);

    // Approval gate, identical to password_login.
    await ensureMembership(svc, user);
    const membership = await getMemberStatus(svc, user.id, defaultTenantId());
    if (membership && membership.status && membership.status !== "approved") {
      const friendly = membership.status === "pending"
        ? "Your account is pending admin approval."
        : membership.status === "denied"
        ? "Your access request was denied" + (membership.denied_reason ? (": " + membership.denied_reason) : ".")
        : "Your account has been deactivated.";
      return json(res, 403, {
        error: { code: "MEMBERSHIP_" + String(membership.status).toUpperCase(), message: friendly, status: membership.status },
      });
    }

    // Mint a session for the user.
    const sess = await mintSessionForUser(svc, email);
    await safeAwait(svc.from("user_security_audit").insert({
      user_id: user.id, user_email: email,
      event: "passkey_login_ok",
    }));
    return json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.user_metadata?.name || null,
      },
      session: {
        access_token: sess.session?.access_token || null,
        refresh_token: sess.session?.refresh_token || null,
        expires_at: sess.session?.expires_at || null,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
