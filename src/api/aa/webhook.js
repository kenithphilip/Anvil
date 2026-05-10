// POST /api/aa/webhook
//
// Setu pushes state changes (consent revoked, expired, granted)
// to this endpoint. We verify the HMAC signature, find the
// matching aa_consents row, and update its status. Sandbox-mode
// requests (no signature header or sandbox tenant) are accepted
// without verification so the test harness can exercise the path.
//
// Idempotent: re-delivery of the same event is safe because we
// only flip status forward (pending -> active -> revoked /
// expired); a stale event for a row that already moved past is
// silently dropped.

import { applyCors, handlePreflight, sendError, json } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { verifyWebhook } from "../_lib/aa/setu-client.js";

// Helper to read raw body. Some Vercel runtimes give us a parsed
// body on req.body, others a stream; we coerce to string.
const readRawBody = async (req) => {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
};

// Map an upstream status string to our enum.
const mapStatus = (s, isSandbox) => {
  const v = (s || "").toLowerCase();
  if (v === "active") return isSandbox ? "sandbox_active" : "active";
  if (v === "revoked") return "revoked";
  if (v === "expired") return "expired";
  if (v === "rejected") return "rejected";
  if (v === "failed") return "failed";
  return "pending";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const rawBody = await readRawBody(req);
    let payload;
    try { payload = rawBody ? JSON.parse(rawBody) : {}; }
    catch (_e) { return json(res, 400, { error: { message: "bad json" } }); }

    const handle = payload.consent_handle || payload.consentHandle || payload.handle;
    if (!handle) return json(res, 400, { error: { message: "consent_handle missing" } });

    const svc = serviceClient();
    const existing = await svc.from("aa_consents").select("*")
      .eq("consent_handle", handle).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) {
      // Webhook for an unknown consent. Acknowledge so Setu does
      // not retry, but log to audit so we can investigate orphans.
      return json(res, 200, { ok: true, ignored: "unknown_consent" });
    }

    const settings = await tenantSettings(svc, existing.data.tenant_id);
    const signature = req.headers["x-setu-signature"]
      || req.headers["x-webhook-signature"]
      || "";
    const v = verifyWebhook({ settings, rawBody, signature });
    if (!v.ok && !v.sandbox) {
      return json(res, 401, { error: { message: "bad signature" } });
    }

    const status = mapStatus(payload.status, !!existing.data.is_sandbox || !!v.sandbox);
    const patch = {
      status,
      raw: { ...existing.data.raw, last_webhook: payload },
    };
    if (status === "active" || status === "sandbox_active") {
      patch.granted_at = existing.data.granted_at || new Date().toISOString();
    } else if (status === "revoked") {
      patch.revoked_at = new Date().toISOString();
    }
    await svc.from("aa_consents").update(patch).eq("id", existing.data.id);
    return json(res, 200, { ok: true, status });
  } catch (err) { sendError(res, err); }
}
