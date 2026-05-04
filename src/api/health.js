// GET /api/health
//
// Public, unauthenticated, tenant-agnostic shell health probe. Returns:
//   - db_ok:        whether the service-role Supabase client can read
//                   one row from a low-cost table.
//   - integrations: env-var presence per integration (configured: bool).
//                   No secret values, just booleans.
//   - version:      package.json version, surfaced from VERCEL_GIT_COMMIT_SHA
//                   when present, otherwise "dev".
//
// The shell footer renders these honestly: "ClamAV not configured" /
// "Tally bridge not configured" when env vars are missing, instead of
// the previous fabricated "online" badges. The previous flow used
// /api/admin/diagnostics which requires admin role, so non-admin users
// always saw "unknown" no matter what.

import { applyCors, handlePreflight, json } from "./_lib/cors.js";
import { serviceClient } from "./_lib/supabase.js";

const INTEGRATIONS = [
  { id: "anthropic",   env: ["ANTHROPIC_API_KEY"],                          label: "Anthropic Claude API" },
  { id: "mistral_ocr", env: ["MISTRAL_API_KEY"],                            label: "Mistral OCR" },
  { id: "clamav",      env: ["CLAMAV_URL", "CLAMAV_TOKEN"],                 label: "ClamAV scanner" },
  { id: "tally",       env: ["TALLY_BRIDGE_URL", "TALLY_BRIDGE_TOKEN"],     label: "Tally bridge" },
  { id: "gstn",        env: ["GSTN_API_URL", "GSTN_API_KEY"],               label: "GSTN e-Invoice" },
  { id: "comms",       env: ["COMMS_PROVIDER_URL", "COMMS_PROVIDER_TOKEN"], label: "Comms provider (generic webhook)" },
  { id: "sendgrid",    env: ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL"], label: "SendGrid (email send)" },
  { id: "email",       env: ["EMAIL_INBOUND_TOKEN"],                        label: "Inbound email webhook" },
  { id: "fx",          env: ["FX_PROVIDER_URL"],                            label: "FX provider" },
  { id: "resend",      env: ["RESEND_API_KEY"],                             label: "Resend (magic links)" },
  // WhatsApp: configured if either provider is set up. We mark configured
  // when ANY of the per-provider env-var tuples are complete; the runtime
  // picks Twilio first, then Meta, then falls back to manual.
  {
    id: "whatsapp_inbound",
    env: ["WHATSAPP_INBOUND_TOKEN"],
    label: "WhatsApp inbound webhook",
  },
  {
    id: "whatsapp_twilio",
    env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"],
    label: "WhatsApp via Twilio",
  },
  {
    id: "whatsapp_meta",
    env: ["META_WHATSAPP_TOKEN", "META_WHATSAPP_PHONE_ID"],
    label: "WhatsApp via Meta Cloud API",
  },
  { id: "agent_runner", env: ["CRON_SECRET"], label: "Autonomous agent cron" },
  { id: "stripe",       env: ["STRIPE_SECRET_KEY"], label: "Stripe (payments platform)" },
  { id: "stripe_webhook", env: ["STRIPE_WEBHOOK_SECRET"], label: "Stripe webhook signing" },
];

let cached = null;
const CACHE_MS = 5_000;

const probeDb = async () => {
  try {
    const svc = serviceClient();
    const { error } = await svc.from("tenants").select("id", { head: true, count: "exact" }).limit(1);
    return !error;
  } catch (_) {
    return false;
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }

  const now = Date.now();
  if (cached && (now - cached.at) < CACHE_MS) {
    return json(res, 200, cached.payload);
  }

  const dbOk = await probeDb();
  const integrations = INTEGRATIONS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    env: spec.env,
    configured: spec.env.every((k) => !!process.env[k]),
  }));

  const payload = {
    db_ok: dbOk,
    integrations,
    runtime: {
      region: process.env.VERCEL_REGION || "local",
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    },
    generated_at: new Date(now).toISOString(),
  };

  cached = { at: now, payload };
  return json(res, 200, payload);
}
