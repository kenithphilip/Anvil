// POST /api/auth/passkey/auth/begin
//
// Step 1 of WebAuthn sign-in. Anonymous endpoint: the visitor
// supplies an email (so we can scope to credentials registered for
// that account). We respond with assertion options + a server-side
// challenge tied to a short-lived "pending login" row.
//
// Body: { email }
//
// We always return options shaped like a normal authentication
// challenge, even when the email is unknown, to avoid leaking
// account existence. The browser will fail to find a credential
// and the user gets a generic error.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import crypto from "node:crypto";

const rpIdFromOrigin = () => {
  const origin = process.env.APP_URL || "http://localhost:5173";
  try { return new URL(origin).hostname; } catch (_) { return "localhost"; }
};
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

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
    if (!email) return json(res, 400, { error: { message: "email required" } });
    const svc = serviceClient();

    // Look up the user; if not found we still return a challenge so
    // the response shape doesn't leak account existence. The
    // browser will then fail to find a matching credential.
    let userId = null;
    try {
      // Audit follow-up (May 2026, regression of H11): switched from
      // project-wide listUsers (which loaded every Supabase user
      // across all tenants on this unauthenticated pre-auth endpoint)
      // to a filtered single-row lookup. No cross-tenant emails are
      // read into memory.
      const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1, email });
      const u = (data?.users || [])[0];
      userId = u?.id || null;
    } catch (_) { userId = null; }

    let allowCredentials = [];
    if (userId) {
      const { data: keys } = await svc.from("user_passkeys")
        .select("credential_id, transports")
        .eq("user_id", userId)
        .not("credential_id", "like", "pending::%");
      allowCredentials = (keys || []).map((k) => ({
        id: k.credential_id,
        type: "public-key",
        transports: (k.transports && k.transports.length) ? k.transports : ["internal", "hybrid", "usb", "nfc", "ble"],
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: rpIdFromOrigin(),
      allowCredentials,
      userVerification: "preferred",
      timeout: 60_000,
    });

    // Stash a SHA-256 of the challenge plus the email under a
    // disposable cred placeholder. We reuse user_passkeys as a
    // throwaway store so we don't need a separate table.
    const placeholderId = "loginchallenge::" + crypto.randomBytes(8).toString("hex");
    if (userId) {
      await svc.from("user_passkeys").upsert({
        user_id: userId,
        credential_id: placeholderId,
        public_key: "",
        counter: 0,
        pending_challenge_hash: sha256Hex(options.challenge),
        pending_challenge_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }, { onConflict: "credential_id" });
    }

    return json(res, 200, { options, challenge_id: placeholderId });
  } catch (err) {
    return sendError(res, err);
  }
}
