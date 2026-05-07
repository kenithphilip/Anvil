// POST /api/auth/passkey/register/begin
//
// Step 1 of WebAuthn registration. The authenticated user clicks
// "Add passkey"; we generate registration options (challenge,
// allowed algorithms, exclude-list of already-registered
// credentials) and persist the challenge hash for later
// verification.
//
// Body: { label?: string }   optional friendly name (e.g. "MacBook Pro").

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import crypto from "node:crypto";

// Computes the relying-party id from APP_URL. Defaults to
// "localhost" so dev works without env config.
const rpIdFromOrigin = () => {
  const origin = process.env.APP_URL || "http://localhost:5173";
  try { return new URL(origin).hostname; } catch (_) { return "localhost"; }
};
const rpOrigin = () => process.env.APP_URL || "http://localhost:5173";

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
    const label = String(body?.label || "").trim().slice(0, 64) || null;
    const svc = serviceClient();

    // Filter out the placeholder rows that register_begin writes to
    // hold the challenge state. Their credential_id is "pending::..."
    // which is NOT a valid base64url string, and feeding it to
    // @simplewebauthn/server's excludeCredentials throws
    // "is not a valid base64url string", breaking every subsequent
    // passkey registration. Only real passkeys (whose credential_id
    // came back from the authenticator as base64url) are excluded.
    const { data: existing } = await svc.from("user_passkeys")
      .select("credential_id")
      .eq("user_id", ctx.user.id)
      .not("credential_id", "like", "pending::%");
    const excludeCredentials = (existing || []).map((p) => ({
      id: p.credential_id,                                 // base64url string
      type: "public-key",
      transports: ["internal", "hybrid", "usb", "nfc", "ble"],
    }));

    const options = await generateRegistrationOptions({
      rpName: "Anvil",
      rpID: rpIdFromOrigin(),
      // The authenticator binds the credential to this user handle.
      // We use the user UUID as bytes so a sign-in by user-handle
      // resolves the right account on the server.
      userID: Buffer.from(ctx.user.id),
      userName: ctx.user.email || ctx.user.id,
      userDisplayName: ctx.user.user_metadata?.name || ctx.user.email || "Anvil user",
      attestationType: "none",                            // we don't ship MDS / corporate attestation handling
      authenticatorSelection: {
        residentKey: "preferred",                          // platform passkey if available
        userVerification: "preferred",
      },
      excludeCredentials,
      timeout: 60_000,
    });

    // Stash the SHA-256 of the challenge so register/finish can
    // verify the round-trip without storing the raw challenge.
    const challengeHash = sha256Hex(options.challenge);
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    // We persist the pending challenge on a one-row-per-user basis
    // by using a placeholder row in user_passkeys with a synthetic
    // credential_id. On finish we pluck-and-clear it. This keeps
    // the schema small (no separate webauthn_challenges table) at
    // the cost of one row per active enrollment.
    const placeholderId = "pending::" + ctx.user.id + "::" + Date.now();
    await svc.from("user_passkeys").upsert({
      user_id: ctx.user.id,
      credential_id: placeholderId,
      public_key: "",
      counter: 0,
      label,
      pending_challenge_hash: challengeHash,
      pending_challenge_expires_at: expiresAt,
    }, { onConflict: "credential_id" });

    return json(res, 200, { options, pending_id: placeholderId });
  } catch (err) {
    return sendError(res, err);
  }
}
