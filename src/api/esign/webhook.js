// POST /api/esign/webhook
//
// DocuSign Connect webhook receiver. Verifies the HMAC signature
// using docusign_webhook_secret, looks up the envelope, advances
// the status (sent -> delivered -> signed -> completed) and writes
// an event row.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { docusignVerifyWebhook } from "../_lib/docusign-client.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let data = ""; req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

// Map DocuSign envelope status -> our status enum.
const mapStatus = (s) => {
  const m = String(s || "").toLowerCase();
  if (m === "sent") return "sent";
  if (m === "delivered") return "delivered";
  if (m === "signed") return "signed";
  if (m === "completed") return "completed";
  if (m === "declined") return "declined";
  if (m === "voided") return "voided";
  return null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const raw = await readRaw(req);
    let body = null;
    try { body = JSON.parse(raw || "{}"); } catch (_e) { return json(res, 400, { error: { message: "invalid json" } }); }
    const envelopeId = body?.data?.envelopeId || body?.envelopeId;
    if (!envelopeId) return json(res, 400, { error: { message: "no envelopeId" } });
    const svc = serviceClient();
    const env = await svc.from("esignature_envelopes").select("*").eq("external_id", envelopeId).maybeSingle();
    if (env.error || !env.data) return json(res, 404, { error: { message: "envelope not found" } });
    const tsQ = await svc.from("tenant_settings").select("docusign_webhook_secret").eq("tenant_id", env.data.tenant_id).maybeSingle();
    const secret = tsQ.data?.docusign_webhook_secret;
    const sig = req.headers["x-docusign-signature-1"] || req.headers["X-DocuSign-Signature-1"];
    if (secret && !docusignVerifyWebhook(raw, sig, secret)) {
      return json(res, 401, { error: { message: "invalid signature" } });
    }
    const evt = body?.event || body?.data?.envelopeSummary?.status || "envelope-update";
    await svc.from("esignature_events").insert({
      tenant_id: env.data.tenant_id,
      envelope_id: env.data.id,
      event: String(evt).slice(0, 100),
      raw: body,
    });
    const status = mapStatus(body?.data?.envelopeSummary?.status || body?.status);
    if (status) {
      const patch = { status, raw: body };
      if (status === "completed") patch.completed_at = new Date().toISOString();
      await svc.from("esignature_envelopes").update(patch).eq("id", env.data.id);
    }
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
