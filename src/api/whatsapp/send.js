// POST /api/whatsapp/send
//
// Outbound WhatsApp send. Provider abstraction: TWILIO if
// TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM are
// set, else META if WHATSAPP_PROVIDER=meta + META_WHATSAPP_TOKEN +
// META_WHATSAPP_PHONE_ID are set. Without any provider configured the
// endpoint marks the row sent and returns 200 so dev environments
// stay functional, mirroring the email comms.send pattern.
//
// Body: { to, body, order_id? }

import { applyCors, handlePreflight, json, readBody } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeFetch } from "../_lib/safe-fetch.js";
import { commsRow } from "../_lib/comms-row.js";

const sanitizePhone = (s) => String(s || "").replace(/[^0-9+]/g, "");

const sendViaTwilio = async (to, body) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return null;
  const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
  const params = new URLSearchParams({
    From: from.startsWith("whatsapp:") ? from : "whatsapp:" + from,
    To: to.startsWith("whatsapp:") ? to : "whatsapp:" + to,
    Body: body,
  });
  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const text = await resp.text();
  return { provider: "twilio", status: resp.status, body: text.slice(0, 4000), ok: resp.ok };
};

const sendViaMeta = async (to, body) => {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return null;
  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(phoneId) + "/messages";
  const resp = await safeFetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: sanitizePhone(to),
      type: "text",
      text: { body },
    }),
  });
  const text = await resp.text();
  return { provider: "meta", status: resp.status, body: text.slice(0, 4000), ok: resp.ok };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const to = sanitizePhone(body?.to);
    const text = String(body?.body || "");
    if (!to || !text) return json(res, 400, { error: { message: "to and body required" } });

    let providerResult = null;
    let configured = false;
    let lastError = null;
    try {
      providerResult = await sendViaTwilio(to, text);
      if (providerResult) configured = true;
    } catch (err) { lastError = err.message; }
    if (!providerResult) {
      try {
        providerResult = await sendViaMeta(to, text);
        if (providerResult) configured = true;
      } catch (err) { lastError = err.message; }
    }

    const status = !configured
      ? "manual"
      : (providerResult && providerResult.ok ? "sent" : "failed");

    const svc = serviceClient();
    const ins = await svc.from("communications").insert(commsRow({
      tenant_id: ctx.tenantId,
      object_type: body?.order_id ? "order" : "whatsapp",
      object_id: body?.order_id || null,
      kind: "whatsapp_outbound",
      to_address: to,
      subject: null,
      body: text,
      status,
      sent_by: ctx.user?.id || null,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      meta: {
        provider: providerResult?.provider || null,
        provider_status: providerResult?.status || null,
        provider_response: providerResult?.body || null,
        error: lastError,
      },
    })).select("id").single();
    if (ins.error) throw new Error(ins.error.message);

    await recordAudit(ctx, {
      action: "comm_send",
      objectType: "communications",
      objectId: ins.data.id,
      detail: "whatsapp::" + status + (configured ? "" : " (no provider configured)"),
    });

    return json(res, 200, {
      ok: status === "sent" || status === "manual",
      status,
      configured,
      provider: providerResult?.provider || null,
      communication_id: ins.data.id,
    });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
