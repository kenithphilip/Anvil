// Microsoft Graph (Outlook) mail provider. docs/CUSTOMER_COMMS_DESIGN.md §5.
//
// Per-tenant OAuth authorization-code flow. The client secret + the access /
// refresh tokens live encrypted on tenant_settings (the _lib/secrets.js
// envelope). Sending uses create-draft-then-send so we capture conversationId +
// internetMessageId for real threading.
//
// SECURITY POSTURE
//   * The Azure directory id and the sender mailbox flow into request URLs, so
//     both are strictly validated / encoded to prevent path injection + SSRF.
//   * The OAuth `state` is an HMAC over (tenant_id, nonce, expiry) keyed off
//     ANVIL_SECRETS_KEY — so the public callback is CSRF-safe and tenant-bound
//     WITHOUT a session, and cannot be forged for another tenant.
//   * No secret, token, or raw provider error body is ever put into a thrown
//     Error message, a log, or an API response (the _lib/oauth2.js M13 rule).
//   * Refresh tokens are never stored or returned in plaintext; the connect flow
//     refuses to run unless ANVIL_SECRETS_KEY is configured.

import crypto from "node:crypto";
import { safeFetch } from "./safe-fetch.js";
import { encryptField, decryptField, newIv, isSecretsConfigured } from "./secrets.js";

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

// Scopes for "create a draft and send it, from a rep OR a shared mailbox":
// Mail.ReadWrite(.Shared) to create the draft (which is what yields the
// conversationId + internetMessageId a bare Mail.Send never returns), Mail.Send(
// .Shared) to send, offline_access for a refresh token. The .Shared variants
// support design point 3 (send-as dispatch@ / accounts@).
// TRADE-OFF, accepted for v1: Mail.ReadWrite grants full read/write of the
// mailbox, not send-only — the price of capturing threading ids via a draft. A
// compromised access token could read that mailbox; scoped to the single sender
// mailbox, encrypted at rest, and refreshable-revocable in Azure.
const SCOPES = [
  "offline_access",
  "Mail.Send", "Mail.Send.Shared",
  "Mail.ReadWrite", "Mail.ReadWrite.Shared",
];

// An Azure directory id is a GUID or a verified domain / 'organizations' /
// 'common'. Anything with a slash, '@', or '?' could rewrite the URL path — so
// allow only GUID/domain characters.
const AZURE_TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const safeAzureTenant = (t) => (AZURE_TENANT_RE.test(String(t || "")) ? String(t) : null);

// The canonical public base URL. PUBLIC_APP_URL is what the rest of the API uses
// (health, invoices/send, stripe, pay-link); GRAPH_REDIRECT_URI can override the
// whole callback URL if the operator registered a different one in Azure.
const publicBase = () => {
  const b = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "";
  return b ? String(b).replace(/\/+$/, "") : "";
};

// The registered redirect URI. Must EXACTLY match the Azure app registration, so
// it comes from config, never from a request header (which is spoofable and
// would break the exact-match check).
export const graphRedirectUri = () => {
  if (process.env.GRAPH_REDIRECT_URI) return process.env.GRAPH_REDIRECT_URI;
  const base = publicBase();
  return base ? base + "/api/comms/graph/callback" : null;
};

// Where the callback sends the admin's browser afterwards (same-origin only —
// never a caller-controlled URL, so there is no open redirect). Hash route to
// match the stripe/aa connect precedent.
export const graphUiReturnUrl = (status) =>
  publicBase() + "/#/admin?tab=communications&graph=" + encodeURIComponent(status);

// ── crypto: creds + tokens on tenant_settings ───────────────────────────────
export const graphEncryptSecret = ({ client_secret }) => {
  const iv = newIv();
  return { graph_client_secret_enc: encryptField(client_secret, iv), graph_creds_iv: iv };
};

export const graphEncryptTokens = ({ access_token, refresh_token }) => {
  const iv = newIv();
  return {
    graph_access_token_enc: access_token ? encryptField(access_token, iv) : null,
    graph_refresh_token_enc: refresh_token ? encryptField(refresh_token, iv) : null,
    graph_token_iv: iv,
  };
};

const decCol = (encCol, ivCol, s) => {
  if (s?.[encCol] && s?.[ivCol]) { try { return decryptField(s[encCol], s[ivCol]); } catch (_e) { return null; } }
  return null;
};
export const graphDecryptSecret = (s) => decCol("graph_client_secret_enc", "graph_creds_iv", s);
export const graphDecryptTokens = (s) => ({
  access_token: decCol("graph_access_token_enc", "graph_token_iv", s),
  refresh_token: decCol("graph_refresh_token_enc", "graph_token_iv", s),
});

// Config lives on the columns migration 028 already added for the inbound Graph
// integration — the SAME app registration + mailbox that receives replies.
export const graphIsConfigured = (s) => !!(
  s?.graph_tenant_id && s?.graph_client_id && s?.graph_mailbox && s?.graph_client_secret_enc
);
export const graphIsConnected = (s) => graphIsConfigured(s) && !!s?.graph_refresh_token_enc;

// ── OAuth `state` — HMAC(tenant_id, nonce, expiry) ───────────────────────────
const b64u = (buf) => Buffer.from(buf).toString("base64url");
// Derive a purpose-specific subkey from the master key so the state MAC is not
// the same key used for AES field encryption.
const stateKey = () => {
  const raw = process.env.ANVIL_SECRETS_KEY;
  if (!raw || raw.length !== 64) throw new Error("ANVIL_SECRETS_KEY not configured");
  return crypto.createHmac("sha256", Buffer.from(raw, "hex")).update("graph-oauth-state-v1").digest();
};

export const signState = (tenantId, ttlMs = 600_000) => {
  const payload = { t: String(tenantId), n: crypto.randomBytes(9).toString("base64url"), e: Date.now() + ttlMs };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", stateKey()).update(body).digest());
  return body + "." + sig;
};

export const verifyState = (state) => {
  const parts = String(state || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac("sha256", stateKey()).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], "base64url"); } catch (_e) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (_e) { return null; }
  if (!payload?.t || !payload?.e || Date.now() > Number(payload.e)) return null;
  return { tenantId: payload.t };
};

// ── authorize URL ────────────────────────────────────────────────────────────
export const buildAuthorizeUrl = ({ azureTenant, clientId, redirectUri, state }) => {
  const t = safeAzureTenant(azureTenant);
  if (!t) { const e = new Error("invalid azure tenant id"); e.status = 400; throw e; }
  const p = new URLSearchParams({
    client_id: String(clientId),
    response_type: "code",
    redirect_uri: String(redirectUri),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state: String(state),
    prompt: "select_account",
  });
  return LOGIN_HOST + "/" + t + "/oauth2/v2.0/authorize?" + p.toString();
};

// ── token endpoint ───────────────────────────────────────────────────────────
const tokenRequest = async (azureTenant, params) => {
  const t = safeAzureTenant(azureTenant);
  if (!t) { const e = new Error("invalid azure tenant id"); e.status = 400; throw e; }
  const resp = await safeFetch(LOGIN_HOST + "/" + t + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = null; }
  if (!resp.ok || !parsed?.access_token) {
    // Status only — the provider body can echo parts of client_id / the code and
    // must never reach a log or a response (oauth2.js M13). We deliberately do
    // NOT attach the body to the error, so no future logger can leak it.
    const err = new Error("graph token request failed: HTTP " + resp.status);
    err.status = resp.status;
    throw err;
  }
  return parsed;
};

export const exchangeCode = ({ azureTenant, clientId, clientSecret, code, redirectUri }) =>
  tokenRequest(azureTenant, new URLSearchParams({
    client_id: String(clientId), client_secret: String(clientSecret),
    grant_type: "authorization_code", code: String(code),
    redirect_uri: String(redirectUri), scope: SCOPES.join(" "),
  }));

export const refreshTokens = ({ azureTenant, clientId, clientSecret, refreshToken }) =>
  tokenRequest(azureTenant, new URLSearchParams({
    client_id: String(clientId), client_secret: String(clientSecret),
    grant_type: "refresh_token", refresh_token: String(refreshToken), scope: SCOPES.join(" "),
  }));

// Return a valid access token for a tenant, refreshing + persisting when the
// stored one is within 60s of expiry. The Azure app registration MUST be a
// confidential client (it has a client secret): its refresh tokens stay valid
// after rotation, so a concurrent double-refresh is harmless (last-write-wins,
// both tokens usable). A public/SPA client would invalidate the old token on
// rotation and a lost race would break the survivor — do not configure one.
export const graphAccessToken = async (svc, settings) => {
  const s = settings;
  const now = Date.now();
  const exp = s.graph_token_expires_at ? Date.parse(s.graph_token_expires_at) : 0;
  const { access_token, refresh_token } = graphDecryptTokens(s);
  if (access_token && exp > now + 60_000) return { accessToken: access_token, sender: s.graph_mailbox };
  if (!refresh_token) { const e = new Error("graph not connected"); e.status = 409; throw e; }

  const parsed = await refreshTokens({
    azureTenant: s.graph_tenant_id, clientId: s.graph_client_id,
    clientSecret: graphDecryptSecret(s), refreshToken: refresh_token,
  });
  const encTok = graphEncryptTokens({
    access_token: parsed.access_token,
    // Azure may or may not return a rotated refresh token; keep the old one if not.
    refresh_token: parsed.refresh_token || refresh_token,
  });
  await svc.from("tenant_settings").update({
    ...encTok,
    graph_token_expires_at: new Date(now + (Number(parsed.expires_in) || 3600) * 1000).toISOString(),
  }).eq("tenant_id", s.tenant_id);
  return { accessToken: parsed.access_token, sender: s.graph_mailbox };
};

// ── send ─────────────────────────────────────────────────────────────────────
const recipients = (list) => (Array.isArray(list) ? list : [list])
  .filter(Boolean).map((email) => ({ emailAddress: { address: String(email) } }));

export const buildGraphMessage = ({ to, cc, bcc, subject, body, attachments }) => {
  const msg = {
    subject: subject || "(no subject)",
    body: { contentType: "HTML", content: (body || "").replace(/\n/g, "<br/>") },
    toRecipients: recipients(to),
  };
  const ccR = recipients(cc); if (ccR.length) msg.ccRecipients = ccR;
  const bccR = recipients(bcc); if (bccR.length) msg.bccRecipients = bccR;
  if (Array.isArray(attachments) && attachments.length) {
    msg.attachments = attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename, contentType: a.type, contentBytes: a.content_base64,
    }));
  }
  return msg;
};

// Create the draft (captures conversationId + internetMessageId) then send it.
// Returns { provider, ok, status, conversationId, internetMessageId, detail }.
// Never throws for a provider-side failure — the caller records it like any
// other provider result.
export const sendViaGraph = async ({ accessToken, sender, to, cc, bcc, subject, body, attachments }) => {
  const mbox = encodeURIComponent(String(sender || ""));
  const headers = { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" };
  try {
    const draftResp = await safeFetch(GRAPH + "/users/" + mbox + "/messages", {
      method: "POST", headers,
      body: JSON.stringify(buildGraphMessage({ to, cc, bcc, subject, body, attachments })),
    });
    const draftText = await draftResp.text();
    let draft = null;
    try { draft = draftText ? JSON.parse(draftText) : null; } catch (_e) { draft = null; }
    if (!draftResp.ok || !draft?.id) {
      return { provider: "graph", ok: false, status: draftResp.status, detail: "graph draft HTTP " + draftResp.status };
    }
    const sendResp = await safeFetch(GRAPH + "/users/" + mbox + "/messages/" + encodeURIComponent(draft.id) + "/send", {
      method: "POST", headers,
    });
    const ok = sendResp.status === 202 || sendResp.ok;
    return {
      provider: "graph", ok, status: sendResp.status,
      conversationId: draft.conversationId || null,
      internetMessageId: draft.internetMessageId || null,
      detail: ok ? "" : "graph send HTTP " + sendResp.status,
    };
  } catch (err) {
    return { provider: "graph", ok: false, status: 0, detail: "graph transport error" };
  }
};

// ── inbound: fetch one message (the reply-loop) ──────────────────────────────
const headerValue = (headers, name) => {
  const target = String(name).toLowerCase();
  for (const h of headers || []) {
    if (String(h.name || "").toLowerCase() === target) return String(h.value || "").trim();
  }
  return null;
};
const stripHtml = (html) => (html ? String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null);

// Fetch one message by id and return the fields the reply-loop needs —
// conversationId + internetMessageId + the In-Reply-To header. Returns null on
// any failure so the caller can leave a stub for a retry. NOTE: internetMessageId
// and the In-Reply-To header are BOTH kept in their raw `<...>` form so the join
// (communications.provider_message_id = reply's In-Reply-To) matches.
export const fetchGraphMessage = async (accessToken, mailbox, messageId) => {
  const mbox = encodeURIComponent(String(mailbox || ""));
  const id = encodeURIComponent(String(messageId || ""));
  const select = "id,conversationId,internetMessageId,subject,from,receivedDateTime,body,internetMessageHeaders";
  try {
    const resp = await safeFetch(GRAPH + "/users/" + mbox + "/messages/" + id + "?$select=" + select, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!resp.ok) return null;
    const m = await resp.json();
    const isHtml = m.body?.contentType === "html" || m.body?.contentType === "HTML";
    return {
      graph_id: m.id || messageId,
      conversationId: m.conversationId || null,
      internetMessageId: m.internetMessageId || null,     // "<...>" as Graph returns it
      inReplyTo: headerValue(m.internetMessageHeaders, "in-reply-to"),
      references: headerValue(m.internetMessageHeaders, "references"),
      subject: m.subject || null,
      from: m.from?.emailAddress?.address || null,
      fromName: m.from?.emailAddress?.name || null,
      receivedAt: m.receivedDateTime || null,
      bodyText: isHtml ? stripHtml(m.body?.content) : (m.body?.content || null),
      bodyHtml: isHtml ? (m.body?.content || null) : null,
    };
  } catch (_e) { return null; }
};

export const graphSecretsReady = () => isSecretsConfigured();
