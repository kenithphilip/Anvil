// The MARKETING send path — deliberately SEPARATE from transactional
// comms-send.js. docs/CUSTOMER_COMMS_DESIGN.md §6.
//
// Marketing and transactional mail are legally distinct (DPDPA + equivalents):
//   * Marketing requires recorded CONSENT, honours SUPPRESSION, carries UNSUBSCRIBE.
//   * Transactional (a payment reminder, a PoD, a dispatch register) must NEVER
//     be gated by any of those — a marketing unsubscribe cannot silence a
//     payment reminder.
//
// The structural guarantee that a marketing suppression can never block a
// transactional send is that the transactional path (comms-send.js) imports
// NOTHING from here, and never reads prospecting_suppressions / marketing_consent.
// This module is the ONLY place those gates live, and it has its own sender
// identity and its own provider call. The invariant is asserted as a test.

import crypto from "node:crypto";
import { safeFetch } from "./safe-fetch.js";

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
// A SEPARATE sender identity from the transactional one (design §6): marketing
// goes out as marketing@, not the rep's mailbox or the transactional from.
const MARKETING_FROM = process.env.MARKETING_FROM_EMAIL || null;
const MARKETING_FROM_NAME = process.env.MARKETING_FROM_NAME || "Anvil";
const appBase = () => String(process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");

const normEmail = (e) => String(e == null ? "" : e).trim().toLowerCase();

// ── unsubscribe token — HMAC(tenant_id, email) ───────────────────────────────
// A tamper-proof public link that identifies exactly who to suppress, with no
// lookup table. Keyed off a purpose-specific subkey of ANVIL_SECRETS_KEY.
const unsubKey = () => {
  const raw = process.env.ANVIL_SECRETS_KEY;
  if (!raw || raw.length !== 64) return null;
  return crypto.createHmac("sha256", Buffer.from(raw, "hex")).update("marketing-unsub-v1").digest();
};

export const signUnsubscribe = (tenantId, email) => {
  const key = unsubKey();
  if (!key || !tenantId || !normEmail(email)) return null;
  const payload = Buffer.from(JSON.stringify({ t: String(tenantId), e: normEmail(email) })).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return payload + "." + sig;
};

export const verifyUnsubscribe = (token) => {
  const key = unsubKey();
  if (!key) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac("sha256", key).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], "base64url"); } catch (_e) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!p?.t || !p?.e) return null;
    return { tenantId: p.t, email: p.e };
  } catch (_e) { return null; }
};

export const unsubscribeUrl = (tenantId, email) => {
  const tok = signUnsubscribe(tenantId, email);
  const base = appBase();
  return (tok && base) ? base + "/api/marketing/unsubscribe?token=" + encodeURIComponent(tok) : null;
};

// ── suppression (marketing only) ─────────────────────────────────────────────
// A tenant-scoped OR global (tenant_id NULL) suppression on prospecting_suppressions.
export const isSuppressed = async (svc, tenantId, email) => {
  const e = normEmail(email);
  if (!e) return true;
  const r = await svc.from("prospecting_suppressions").select("id")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`).eq("email", e).limit(1);
  return !!(r.data && r.data.length);
};

export const addSuppression = async (svc, tenantId, email, reason = "unsubscribe") => {
  const e = normEmail(email);
  if (!e) return false;
  const r = await svc.from("prospecting_suppressions")
    .upsert({ tenant_id: tenantId, email: e, reason }, { onConflict: "tenant_id,email" });
  return !r.error;
};

// ── send one marketing message ───────────────────────────────────────────────
// Enforces consent (asserted by the caller — only consented recipients reach
// here) + suppression, and always attaches an unsubscribe footer + the RFC 8058
// one-click List-Unsubscribe headers (required by Gmail/Yahoo bulk rules).
// Returns { ok, status?, skipped?, provider?, detail?, unsubscribe_url? }.
export const sendMarketing = async (svc, tenantId, { to, subject, body, consented }) => {
  const email = normEmail(to);
  if (!email) return { ok: false, skipped: "no_recipient" };
  // Consent is non-negotiable for marketing: absence means no send.
  if (consented !== true) return { ok: false, skipped: "no_consent" };
  if (await isSuppressed(svc, tenantId, email)) return { ok: false, skipped: "suppressed" };

  const unsub = unsubscribeUrl(tenantId, email);
  const footer = unsub ? "\n\n—\nYou are receiving this because you opted in. Unsubscribe: " + unsub : "";
  const fullBody = String(body || "") + footer;

  if (!SENDGRID_KEY || !MARKETING_FROM) return { ok: false, skipped: "no_provider", unsubscribe_url: unsub };

  const payload = {
    personalizations: [{ to: [{ email }] }],
    from: { email: MARKETING_FROM, name: MARKETING_FROM_NAME },
    subject: subject || "(no subject)",
    content: [
      { type: "text/plain", value: fullBody },
      { type: "text/html", value: fullBody.replace(/\n/g, "<br/>") },
    ],
  };
  if (unsub) {
    payload.headers = { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  }
  try {
    const resp = await safeFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + SENDGRID_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return {
      ok: resp.ok, status: resp.status, provider: "sendgrid_marketing",
      detail: resp.ok ? "" : "marketing send HTTP " + resp.status, unsubscribe_url: unsub,
    };
  } catch (_e) {
    return { ok: false, status: 0, provider: "sendgrid_marketing", detail: "marketing transport error", unsubscribe_url: unsub };
  }
};
