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
import { resolveAttachments } from "./comms-attachments.js";
import { graphIsConnected, graphAccessToken, sendViaGraph } from "./graph-client.js";
import { sendEmail } from "./mailer.js";

const PROVIDER_URL = process.env.COMMS_PROVIDER_URL;
const PROVIDER_TOKEN = process.env.COMMS_PROVIDER_TOKEN;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "Anvil";

// Email now routes through the switchable provider mailer (Brevo / Resend /
// SendGrid, selected by EMAIL_PROVIDER). Kept named sendViaSendGrid so the
// dispatch chain below is untouched; returns null when no provider is
// configured so the caller falls through to the generic webhook / manual path,
// exactly as before. (The cc/bcc-in-one-personalization behaviour that makes a
// dispatch register land TO stores with purchase/accounts in CC is preserved by
// the mailer.)
const sendViaSendGrid = async ({ to, cc, bcc, replyTo, subject, body, from, attachments }) => {
  const r = await sendEmail({ to, cc, bcc, replyTo, subject, body, from, attachments });
  if (r.skipped) return null;
  return { provider: r.provider, status: r.status, ok: r.ok, detail: r.detail };
};

const sendViaChat = async (svc, tenantId, channel, { to, subject, body }) => {
  // Teams outbound is not built: a Teams reply needs the service_url from the
  // inbound activity, and this path never has it. It used to answer ok: true
  // with status 202, so the row was marked sent and nothing left. It now says
  // not configured, before the config lookup, so a Teams row never falls
  // through to the email providers with a Teams address either.
  if (channel === "teams") {
    return {
      provider: "teams", status: 0, ok: false, notConfigured: true,
      detail: "Teams outbound is not available (a Teams reply needs the service_url from an inbound activity), so nothing was sent",
    };
  }

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

// Why a sendCommunication result did not go out, in words a screen can show.
// Callers that send in the request (quotes/send, copilot confirm) report
// this instead of a success when the row is not `sent`.
export const notSentReason = (result) => {
  if (!result || result.notFound) return "The message row could not be read back, so nothing was sent.";
  if (result.error) return String(result.error);
  // A provider that threw (for example an Outlook token refresh that failed)
  // leaves no provider result, so `configured` reads false. Saying "no
  // provider is configured" would then send the operator to set up a
  // provider that is already connected. Report the failure itself.
  if (result.lastError) return "The send failed: " + String(result.lastError);
  if (result.configured === false) return "No provider is configured for this channel, so the message was not sent.";
  return "The message was not sent (status " + (result.communication?.status || "unknown") + ").";
};

// A row the send core left `queued` (nothing took it), after the caller has
// told the user it was not sent. Mark it failed with the reason. A queued
// row is drained later by the agents/run reaper, which would then deliver a
// message the user was told did not go, and a second time if they re-sent
// it another way. Only a row that is still `queued` is touched. Returns the
// row's final status, plus `error` when the update failed.
export const failUnsentRow = async (svc, ctx, commId, result, reason) => {
  const status = result?.communication?.status || null;
  if (status !== "queued") return { status };
  const upd = await svc.from("communications").update({
    status: "failed",
    updated_at: new Date().toISOString(),
    metadata: { ...(result?.communication?.metadata || {}), not_sent_reason: reason },
  }).eq("tenant_id", ctx.tenantId).eq("id", commId).eq("status", "queued");
  if (upd?.error) return { status, error: upd.error.message };
  return { status: "failed" };
};

// Send an existing communications draft row by id. Returns:
//   { notFound: true }                              - no such row
//   { idempotent: true, communication }             - already sent
//   { communication, provider, configured, error, lastError }
//                                                   - send attempted; lastError
//                                                     is a provider that threw
export const sendCommunication = async (svc, ctx, commId) => {
  const row = await svc.from("communications").select("*").eq("tenant_id", ctx.tenantId).eq("id", commId).single();
  if (row.error || !row.data) return { notFound: true };
  // 'replied' is terminal too (the reply-loop flips a sent row to replied) — never resend it.
  if (row.data.status === "sent" || row.data.status === "replied") return { idempotent: true, communication: row.data };
  // Marketing has its OWN send path (_lib/marketing-send.js): consent +
  // suppression + unsubscribe + a separate sender identity. The transactional
  // sender must NEVER (re)send a marketing row — that would use the transactional
  // identity, drop the unsubscribe footer/headers, and skip the gates. Refuse it
  // here so the guarantee holds at EVERY transactional entry point (the copilot
  // path + POST /api/communications/send), not only the reaper.
  if (row.data.document_type === "marketing") return { skipped: "marketing_row", communication: row.data };

  let providerResult = null;
  let lastError = null;

  // Resolve attachments BEFORE choosing a provider. Failures are reported, not
  // thrown — but a document that was REQUESTED and could not be attached is a
  // hard failure: silently mailing a dispatch register without its register is
  // worse than not sending. (An over-cap set clears `attachments` and reports
  // too_large, which lands here the same way.)
  const att = await resolveAttachments(svc, ctx.tenantId, row.data.attachments);
  if (att.errors.length) {
    await svc.from("communications").update({
      status: "failed",
      updated_at: new Date().toISOString(),
      metadata: { ...(row.data.metadata || {}), attachment_errors: att.errors },
    }).eq("tenant_id", ctx.tenantId).eq("id", commId);
    return {
      communication: { ...row.data, status: "failed" },
      configured: false,
      error: "attachment_unresolved: " + att.errors.map((e) => e.reason).join(", "),
      attachment_errors: att.errors,
    };
  }

  const chatChannels = new Set(["whatsapp", "slack", "teams"]);
  if (chatChannels.has(row.data.channel)) {
    try {
      providerResult = await sendViaChat(svc, ctx.tenantId, row.data.channel, {
        to: row.data.to_addr, subject: row.data.subject, body: row.data.body,
      });
    } catch (err) { lastError = err.message; }
  }

  // Graph (Outlook) is preferred for email when the tenant has connected it: the
  // mail lands in the sender's own Sent Items and we get conversationId +
  // internetMessageId for real threading. Loaded lazily; falls through to
  // SendGrid when Graph is not connected or the token refresh fails.
  let graphSettings = null;
  if (!providerResult && !chatChannels.has(row.data.channel)) {
    try {
      const st = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
      graphSettings = st.data ? { ...st.data, tenant_id: ctx.tenantId } : null;
    } catch (_e) { graphSettings = null; }
    if (graphIsConnected(graphSettings)) {
      try {
        const { accessToken, sender } = await graphAccessToken(svc, graphSettings);
        providerResult = await sendViaGraph({
          accessToken, sender,
          to: row.data.to_addr, cc: row.data.cc_addrs, bcc: row.data.bcc_addrs,
          subject: row.data.subject, body: row.data.body, attachments: att.attachments,
        });
      } catch (err) { lastError = err.message; }
    }
  }

  if (!providerResult) {
    try {
      providerResult = await sendViaSendGrid({
        to: row.data.to_addr,
        cc: row.data.cc_addrs, bcc: row.data.bcc_addrs, replyTo: row.data.reply_to,
        subject: row.data.subject, body: row.data.body, from: row.data.from_addr,
        attachments: att.attachments,
      });
    }
    catch (err) { lastError = err.message; }
  }
  if (!providerResult) {
    try { providerResult = await sendViaGenericWebhook({ to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr }); }
    catch (err) { lastError = err.message; }
  }

  // A channel that answers notConfigured (Teams) sent nothing and cannot send
  // on this path at all. It counts as not configured, and the row is failed,
  // not queued: a queued row would come back to the reaper on every tick for a
  // send that can never happen.
  const notConfigured = !!providerResult?.notConfigured;
  const configured = !!providerResult && !notConfigured;
  const errorMsg = notConfigured
    ? "not_configured: " + providerResult.detail
    : (configured && !providerResult.ok ? "Provider " + providerResult.provider + " returned " + providerResult.status : null);
  // NOT "sent". With no provider configured nothing was transmitted, so
  // recording `sent` (and stamping sent_at) was a lie — and any analytics built
  // on status='sent' would have been measuring fiction. `queued` is honest: the
  // row is ready and a human or a later provider can pick it up. The parallel
  // reaper in agents/run.js:337-341 was already fixed for exactly this bug.
  const newStatus = notConfigured ? "failed" : (!configured ? "queued" : (providerResult.ok ? "sent" : "failed"));

  const update = {
    status: newStatus,
    sent_at: newStatus === "sent" ? new Date().toISOString() : null,
    metadata: {
      ...(row.data.metadata || {}),
      provider: providerResult?.provider || "manual",
      provider_status: providerResult?.status || null,
      provider_detail: providerResult?.detail || null,
      provider_error: errorMsg,
      last_error: lastError,
    },
  };
  // Real threading from Graph: store the conversationId + internetMessageId so a
  // reply CAN be attributed to this exact message. The inbound join that closes
  // that loop (match a reply's conversationId/in_reply_to back to this row) is a
  // follow-up — inbound currently threads on the RFC Message-ID chain. Only set
  // when present; never clobber an existing thread.
  if (providerResult?.provider) update.provider = providerResult.provider;
  if (providerResult?.internetMessageId) update.provider_message_id = providerResult.internetMessageId;
  if (providerResult?.conversationId && !row.data.thread_id) update.thread_id = providerResult.conversationId;

  const updated = await svc.from("communications").update(update).eq("id", commId).select("*").single();
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

  return { communication: updated.data, provider: providerResult?.provider || "manual", configured, error: errorMsg, lastError };
};
