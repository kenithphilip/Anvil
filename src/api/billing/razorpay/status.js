// GET /api/billing/razorpay/status

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { tenantSettings } from "../../_lib/stripe-client.js";
import { razorpayDecryptCreds, razorpayIsConfigured } from "../../_lib/razorpay-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: { message: "Method not allowed" } }); }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = razorpayDecryptCreds(settingsRaw);
    return json(res, 200, {
      configured: razorpayIsConfigured(settings),
      account_id: settingsRaw?.razorpay_account_id || null,
      charges_enabled: !!settingsRaw?.razorpay_charges_enabled,
      payouts_enabled: !!settingsRaw?.razorpay_payouts_enabled,
      platform_fee_bps: settingsRaw?.razorpay_platform_fee_bps || 0,
      webhook_secret_set: !!settingsRaw?.razorpay_webhook_secret,
      connected_at: settingsRaw?.razorpay_connected_at || null,
      storage_mode: (settingsRaw?.razorpay_key_id_enc && settingsRaw?.razorpay_creds_iv) ? "encrypted"
        : (settingsRaw?.razorpay_key_id ? "plaintext" : "none"),
    });
  } catch (err) { sendError(res, err); }
}
