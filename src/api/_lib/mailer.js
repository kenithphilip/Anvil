// Provider-agnostic transactional email sender.
//
// One place to send an automated email (account-creation welcome, forgot-
// password, and — future — quotes / dispatch registers / reminders & alerts),
// switchable between providers by env so we're not locked to any one vendor.
//
//   EMAIL_PROVIDER = brevo | resend | sendgrid   (default: auto-detect by which
//                    API key is set, in that order)
//   EMAIL_FROM       sender address   (falls back to SENDGRID_FROM_EMAIL)
//   EMAIL_FROM_NAME  sender name      (falls back to SENDGRID_FROM_NAME, "Anvil")
//   BREVO_API_KEY    | RESEND_API_KEY | SENDGRID_API_KEY
//
// NOTE: Supabase Auth's OWN emails (the invite magic-link and the
// resetPasswordForEmail happy-path) are sent by Supabase, not this module —
// configure those under Supabase → Auth → SMTP with the same provider's SMTP
// creds. This module powers the app-sent emails (the reset manual-fallback,
// welcome, and future transactional/notification mail) + is shared by
// comms-send.js so every app email uses one switchable provider.
//
// Pure over the injected fetch (safeFetch); no SMTP dependency — all three
// providers are driven via their HTTPS APIs, which is the right shape for the
// serverless runtime. Never throws: returns a structured result so callers can
// log/surface delivery status without a try/catch.

import { safeFetch } from "./safe-fetch.js";

const FROM_EMAIL = process.env.EMAIL_FROM || process.env.SENDGRID_FROM_EMAIL || "";
const FROM_NAME = process.env.EMAIL_FROM_NAME || process.env.SENDGRID_FROM_NAME || "Anvil";

// Which provider is active, or null when none is configured. Explicit
// EMAIL_PROVIDER wins (and must have its key); otherwise auto-detect.
export const emailProvider = () => {
  const explicit = String(process.env.EMAIL_PROVIDER || "").toLowerCase().trim();
  const keyed = {
    brevo: !!process.env.BREVO_API_KEY,
    resend: !!process.env.RESEND_API_KEY,
    sendgrid: !!(process.env.SENDGRID_API_KEY && FROM_EMAIL),
  };
  if (explicit) return keyed[explicit] ? explicit : null;
  if (keyed.brevo) return "brevo";
  if (keyed.resend) return "resend";
  if (keyed.sendgrid) return "sendgrid";
  return null;
};

// True when an app-email provider is usable (a provider is selected AND we have
// a from address). Surfaced by the health check so a misconfig is visible.
export const emailConfigured = () => !!emailProvider() && !!FROM_EMAIL;

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const htmlFrom = (msg) => msg.html || String(msg.text || msg.body || "").replace(/\n/g, "<br/>");
const textFrom = (msg) => msg.text || msg.body || (msg.html ? String(msg.html).replace(/<[^>]+>/g, "") : "");

const sendViaBrevo = async (msg, from) => {
  const attachment = asList(msg.attachments).map((a) => ({ name: a.filename, content: a.content_base64 || a.content }));
  const payload = {
    sender: { email: from.email, name: from.name },
    to: asList(msg.to).map((email) => ({ email })),
    subject: msg.subject || "(no subject)",
    htmlContent: htmlFrom(msg),
    textContent: textFrom(msg),
  };
  if (asList(msg.cc).length) payload.cc = asList(msg.cc).map((email) => ({ email }));
  if (asList(msg.bcc).length) payload.bcc = asList(msg.bcc).map((email) => ({ email }));
  if (msg.replyTo) payload.replyTo = { email: msg.replyTo };
  if (attachment.length) payload.attachment = attachment;
  const resp = await safeFetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const detail = resp.ok ? "" : (await resp.text()).slice(0, 4000);
  return { ok: resp.ok, provider: "brevo", status: resp.status, detail };
};

const sendViaResend = async (msg, from) => {
  const payload = {
    from: from.name ? `${from.name} <${from.email}>` : from.email,
    to: asList(msg.to),
    subject: msg.subject || "(no subject)",
    html: htmlFrom(msg),
    text: textFrom(msg),
  };
  if (asList(msg.cc).length) payload.cc = asList(msg.cc);
  if (asList(msg.bcc).length) payload.bcc = asList(msg.bcc);
  if (msg.replyTo) payload.reply_to = msg.replyTo;
  const att = asList(msg.attachments).map((a) => ({ filename: a.filename, content: a.content_base64 || a.content }));
  if (att.length) payload.attachments = att;
  const resp = await safeFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const detail = resp.ok ? "" : (await resp.text()).slice(0, 4000);
  return { ok: resp.ok, provider: "resend", status: resp.status, detail };
};

const sendViaSendGrid = async (msg, from) => {
  const addrs = (list) => asList(list).map((email) => ({ email }));
  const personalization = { to: addrs(msg.to) };
  if (addrs(msg.cc).length) personalization.cc = addrs(msg.cc);
  if (addrs(msg.bcc).length) personalization.bcc = addrs(msg.bcc);
  const payload = {
    personalizations: [personalization],
    from: { email: from.email, name: from.name },
    subject: msg.subject || "(no subject)",
    content: [
      { type: "text/plain", value: textFrom(msg) },
      { type: "text/html", value: htmlFrom(msg) },
    ],
  };
  if (msg.replyTo) payload.reply_to = { email: msg.replyTo };
  const att = asList(msg.attachments).map((a) => ({ filename: a.filename, type: a.type, content: a.content_base64 || a.content, disposition: "attachment" }));
  if (att.length) payload.attachments = att;
  const resp = await safeFetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const detail = resp.ok ? "" : (await resp.text()).slice(0, 4000);
  return { ok: resp.ok, provider: "sendgrid", status: resp.status, detail };
};

const ADAPTERS = { brevo: sendViaBrevo, resend: sendViaResend, sendgrid: sendViaSendGrid };

// sendEmail({ to, cc?, bcc?, replyTo?, subject, html?, text?, body?, from?,
//             fromName?, attachments? }) -> { ok, provider, status, detail }
// When no provider is configured OR there's no recipient/from, returns a
// non-throwing { ok:false, skipped:true, reason } so callers can log + move on.
export const sendEmail = async (msg = {}) => {
  const provider = emailProvider();
  const from = { email: msg.from || FROM_EMAIL, name: msg.fromName || FROM_NAME };
  if (!provider) return { ok: false, provider: null, skipped: true, reason: "not_configured" };
  if (!from.email) return { ok: false, provider, skipped: true, reason: "no_from_address" };
  if (!asList(msg.to).length) return { ok: false, provider, skipped: true, reason: "no_recipient" };
  try {
    return await ADAPTERS[provider](msg, from);
  } catch (err) {
    return { ok: false, provider, status: 0, detail: (err && err.message) || String(err) };
  }
};
