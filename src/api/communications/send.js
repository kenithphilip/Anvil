// POST /api/communications/send
// Body: { id }   (id of an existing draft)
//
// Marks the draft sent. Provider abstraction:
//   1. SendGrid (SENDGRID_API_KEY + SENDGRID_FROM_EMAIL) for email.
//   2. Generic webhook (COMMS_PROVIDER_URL) as a fallback.
//   3. Manual (no provider) keeps the draft in `sent` so the timeline
//      view stays useful in dev.
//
// The matching outbound for WhatsApp lives at /api/whatsapp/send.
// SMS is provider-agnostic too; if we add a Twilio SMS branch later
// it slots in here as a third sendVia* helper.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const PROVIDER_URL = process.env.COMMS_PROVIDER_URL;
const PROVIDER_TOKEN = process.env.COMMS_PROVIDER_TOKEN;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "Anvil";

const sendViaSendGrid = async ({ to, subject, body, from }) => {
  if (!SENDGRID_KEY || !SENDGRID_FROM) return null;
  const fromAddress = from || SENDGRID_FROM;
  // SendGrid v3 mail/send. We post HTML + plain so legacy clients
  // still render the message even if HTML is stripped. Keep the
  // payload minimal so the failure mode is auditable from the row.
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromAddress, name: SENDGRID_FROM_NAME },
    subject: subject || "(no subject)",
    content: [
      { type: "text/plain", value: body || "" },
      { type: "text/html",  value: (body || "").replace(/\n/g, "<br/>") },
    ],
  };
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SENDGRID_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    // SendGrid returns 202 on success with no body; 4xx/5xx have JSON
    // error envelopes we surface to the caller.
    const text = resp.ok ? "" : await resp.text();
    return {
      provider: "sendgrid",
      status: resp.status,
      ok: resp.ok,
      detail: text.slice(0, 4000),
    };
  } catch (err) {
    return {
      provider: "sendgrid",
      status: 0,
      ok: false,
      detail: err.message || String(err),
    };
  }
};

const sendViaGenericWebhook = async ({ to, subject, body, from }) => {
  if (!PROVIDER_URL) return null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (PROVIDER_TOKEN) headers["Authorization"] = "Bearer " + PROVIDER_TOKEN;
    const upstream = await fetch(PROVIDER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ to, subject, body, from }),
    });
    const text = upstream.ok ? "" : await upstream.text();
    return {
      provider: "generic",
      status: upstream.status,
      ok: upstream.ok,
      detail: text.slice(0, 4000),
    };
  } catch (err) {
    return {
      provider: "generic",
      status: 0,
      ok: false,
      detail: err.message || String(err),
    };
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body || !body.id) return json(res, 400, { error: { message: "id required" } });
    const svc = serviceClient();
    const row = await svc.from("communications").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
    if (row.error || !row.data) return json(res, 404, { error: { message: "Draft not found" } });
    if (row.data.status === "sent") return json(res, 200, { ok: true, idempotent: true });

    // Provider order: SendGrid first, generic webhook second, manual
    // (no provider) third. The first one that returns non-null wins.
    let providerResult = null;
    let lastError = null;
    try { providerResult = await sendViaSendGrid({
      to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr,
    }); } catch (err) { lastError = err.message; }
    if (!providerResult) {
      try { providerResult = await sendViaGenericWebhook({
        to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr,
      }); } catch (err) { lastError = err.message; }
    }

    const configured = !!providerResult;
    const errorMsg = configured && !providerResult.ok ? "Provider " + providerResult.provider + " returned " + providerResult.status : null;
    const newStatus = !configured ? "sent" : (providerResult.ok ? "sent" : "failed");

    const updated = await svc.from("communications").update({
      status: newStatus,
      sent_at: new Date().toISOString(),
      metadata: {
        ...(row.data.metadata || {}),
        provider: providerResult?.provider || "manual",
        provider_status: providerResult?.status || null,
        provider_detail: providerResult?.detail || null,
        provider_error: errorMsg,
        last_error: lastError,
      },
    }).eq("id", body.id).select("*").single();
    if (updated.error) throw new Error(updated.error.message);

    await recordAudit(ctx, {
      action: "comm_send",
      objectType: "communication",
      objectId: body.id,
      detail: providerResult ? (providerResult.provider + "::" + newStatus) : "manual::sent",
    });
    if (row.data.order_id) await recordEvent(ctx, {
      caseId: row.data.order_id,
      eventType: errorMsg ? "comm_send_failed" : "comm_sent",
      objectType: "communication",
      objectId: body.id,
    });

    return json(res, 200, {
      communication: updated.data,
      provider: providerResult?.provider || "manual",
      configured,
      error: errorMsg,
    });
  } catch (err) {
    sendError(res, err);
  }
}
