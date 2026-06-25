// Shared communications send core (PR2).
//
// Lifted verbatim from communications/send.js so both the send endpoint
// and the copilot confirm-and-execute path drive the exact same provider
// logic + status update + audit. Behavior is unchanged from the original
// handler; send.js now delegates here.
//
// Provider order: tenant chat config (whatsapp/slack/teams) -> SendGrid
// -> generic webhook -> manual (dev). Idempotent on an already-sent row.

import { recordAudit, recordEvent } from "./audit.js";
import { decryptChatCreds } from "./inbound-chat.js";
import { safeFetch } from "./safe-fetch.js";

const PROVIDER_URL = process.env.COMMS_PROVIDER_URL;
const PROVIDER_TOKEN = process.env.COMMS_PROVIDER_TOKEN;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "Anvil";

const sendViaSendGrid = async ({ to, subject, body, from }) => {
  if (!SENDGRID_KEY || !SENDGRID_FROM) return null;
  const fromAddress = from || SENDGRID_FROM;
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromAddress, name: SENDGRID_FROM_NAME },
    subject: subject || "(no subject)",
    content: [
      { type: "text/plain", value: body || "" },
      { type: "text/html", value: (body || "").replace(/\n/g, "<br/>") },
    ],
  };
  try {
    const resp = await safeFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + SENDGRID_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = resp.ok ? "" : await resp.text();
    return { provider: "sendgrid", status: resp.status, ok: resp.ok, detail: text.slice(0, 4000) };
  } catch (err) {
    return { provider: "sendgrid", status: 0, ok: false, detail: err.message || String(err) };
  }
};

const sendViaChat = async (svc, tenantId, channel, { to, subject, body }) => {
  const { data: config } = await svc.from("inbound_chat_configs")
    .select("*").eq("tenant_id", tenantId).eq("channel", channel).eq("active", true).maybeSingle();
  if (!config) return null;
  const creds = decryptChatCreds(config);

  if (channel === "whatsapp") {
    if (!creds.account_sid || !creds.auth_token || !creds.from_number) return null;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.account_sid}/Messages.json`;
    const formBody = new URLSearchParams({
      From: creds.from_number.startsWith("whatsapp:") ? creds.from_number : "whatsapp:" + creds.from_number,
      To: to.startsWith("whatsapp:") ? to : "whatsapp:" + to,
      Body: [subject ? subject + "\n\n" : "", body || ""].join(""),
    }).toString();
    const auth = Buffer.from(`${creds.account_sid}:${creds.auth_token}`).toString("base64");
    try {
      const resp = await safeFetch(url, {
        method: "POST",
        headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody,
      });
      const text = resp.ok ? "" : await resp.text();
      return { provider: "twilio_whatsapp", status: resp.status, ok: resp.ok, detail: text.slice(0, 4000) };
    } catch (err) {
      return { provider: "twilio_whatsapp", status: 0, ok: false, detail: err.message || String(err) };
    }
  }

  if (channel === "slack") {
    if (!creds.bot_token) return null;
    try {
      const resp = await safeFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: "Bearer " + creds.bot_token, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: to, text: [subject ? "*" + subject + "*" : "", body].filter(Boolean).join("\n") }),
      });
      const j = await resp.json();
      return { provider: "slack", status: resp.status, ok: !!j.ok, detail: JSON.stringify(j).slice(0, 4000) };
    } catch (err) {
      return { provider: "slack", status: 0, ok: false, detail: err.message || String(err) };
    }
  }

  if (channel === "teams") {
    return { provider: "teams", status: 202, ok: true, detail: "queued (Teams reply requires service_url from inbound activity)" };
  }

  return null;
};

const sendViaGenericWebhook = async ({ to, subject, body, from }) => {
  if (!PROVIDER_URL) return null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (PROVIDER_TOKEN) headers["Authorization"] = "Bearer " + PROVIDER_TOKEN;
    const upstream = await safeFetch(PROVIDER_URL, {
      method: "POST", headers, body: JSON.stringify({ to, subject, body, from }),
    });
    const text = upstream.ok ? "" : await upstream.text();
    return { provider: "generic", status: upstream.status, ok: upstream.ok, detail: text.slice(0, 4000) };
  } catch (err) {
    return { provider: "generic", status: 0, ok: false, detail: err.message || String(err) };
  }
};

// Send an existing communications draft row by id. Returns:
//   { notFound: true }                              - no such row
//   { idempotent: true, communication }             - already sent
//   { communication, provider, configured, error }  - send attempted
export const sendCommunication = async (svc, ctx, commId) => {
  const row = await svc.from("communications").select("*").eq("tenant_id", ctx.tenantId).eq("id", commId).single();
  if (row.error || !row.data) return { notFound: true };
  if (row.data.status === "sent") return { idempotent: true, communication: row.data };

  let providerResult = null;
  let lastError = null;
  const chatChannels = new Set(["whatsapp", "slack", "teams"]);
  if (chatChannels.has(row.data.channel)) {
    try {
      providerResult = await sendViaChat(svc, ctx.tenantId, row.data.channel, {
        to: row.data.to_addr, subject: row.data.subject, body: row.data.body,
      });
    } catch (err) { lastError = err.message; }
  }
  if (!providerResult) {
    try { providerResult = await sendViaSendGrid({ to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr }); }
    catch (err) { lastError = err.message; }
  }
  if (!providerResult) {
    try { providerResult = await sendViaGenericWebhook({ to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr }); }
    catch (err) { lastError = err.message; }
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
  }).eq("id", commId).select("*").single();
  if (updated.error) throw new Error(updated.error.message);

  await recordAudit(ctx, {
    action: "comm_send",
    objectType: "communication",
    objectId: commId,
    detail: providerResult ? (providerResult.provider + "::" + newStatus) : "manual::sent",
  });
  if (row.data.order_id) await recordEvent(ctx, {
    caseId: row.data.order_id,
    eventType: errorMsg ? "comm_send_failed" : "comm_sent",
    objectType: "communication",
    objectId: commId,
  });

  return { communication: updated.data, provider: providerResult?.provider || "manual", configured, error: errorMsg };
};
