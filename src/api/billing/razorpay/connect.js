// POST /api/billing/razorpay/connect
// Body: { key_id, key_secret, account_id?, webhook_secret?, platform_fee_bps? }
// Stores credentials, runs a probe (GET /v1/payments?count=1), flips
// charges_enabled flag.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../../_lib/stripe-client.js";
import { razorpayEncryptCreds, razorpayDecryptCreds, razorpayFetch } from "../../_lib/razorpay-client.js";
import { isSecretsConfigured } from "../../_lib/secrets.js";
import { safeProbeError } from "../../_lib/sanitize.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    if (!body?.key_id || !body?.key_secret) return json(res, 400, { error: { message: "key_id and key_secret required" } });
    const svc = serviceClient();
    await tenantSettings(svc, ctx.tenantId);
    const enc = razorpayEncryptCreds({ key_id: body.key_id, key_secret: body.key_secret });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      razorpay_account_id: body.account_id || null,
      razorpay_webhook_secret: body.webhook_secret || null,
      razorpay_platform_fee_bps: Number.isFinite(body.platform_fee_bps) ? body.platform_fee_bps : 0,
      ...enc,
    });
    const decrypted = razorpayDecryptCreds(updated);
    let probe = null;
    try {
      probe = await razorpayFetch(decrypted, { method: "GET", path: "/v1/payments?count=1" });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, {
        razorpay_charges_enabled: true,
        razorpay_payouts_enabled: true,
        razorpay_connected_at: new Date().toISOString(),
      });
    }
    await recordAudit(ctx, {
      action: "razorpay_connect",
      objectType: "tenant_settings",
      objectId: ctx.tenantId,
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });
    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: safeProbeError(probe, "connection_failed"),
      storage_mode: isSecretsConfigured() ? "encrypted" : "plaintext",
    });
  } catch (err) { sendError(res, err); }
}
