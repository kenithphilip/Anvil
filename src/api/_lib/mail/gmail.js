// Gmail mailbox adapter, read only. docs/EMAIL_ACCOUNTABILITY_SCOPE.md 5.2.
//
// OAuth on the tenant's own Google client (tenant_settings.google_oauth_*),
// an Internal app in the customer's Workspace (plan ED-3), so Google needs no
// app verification and no CASA assessment.
//
// Scope: gmail.readonly only. gmail.metadata is narrower but also restricted,
// and it cannot use `q` for a bounded first sync. Messages are read with
// format=metadata: headers and the snippet, never a body.
//
// One checkpoint for both directions: { historyId, pageToken? }. The first
// sync lists `after:<since> (in:inbox OR in:sent)` with
// { mode: "list", historyId, pageToken }, where historyId is read before the
// list, so nothing that arrives during the list is lost.

import { safeFetch } from "../safe-fetch.js";
import { decryptField } from "../secrets.js";
import { MailError, mailFetch, normAddr, parseIdList } from "./provider.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export const folders = ["all"];
// Each message is one request; a small page keeps a page inside one tick.
export const pageSize = 20;

const HEADERS = [
  "Message-ID", "In-Reply-To", "References", "From", "To", "Cc", "Subject", "Date",
  "Auto-Submitted", "List-Unsubscribe", "Precedence",
];

export const isConfigured = (s) => !!(s?.google_oauth_client_id && s?.google_oauth_client_secret_enc);

const clientSecret = (s) => {
  try { return decryptField(s.google_oauth_client_secret_enc); } catch { return null; }
};

export const authorizeUrl = ({ settings, state, redirectUri }) => AUTH + "?" + new URLSearchParams({
  client_id: settings.google_oauth_client_id,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: GMAIL_SCOPES.join(" "),
  access_type: "offline",
  // Google returns a refresh token only on consent.
  prompt: "consent",
  include_granted_scopes: "false",
  state,
}).toString();

// 400 and 401 from the token endpoint mean the grant is gone. The provider
// body is never put into the error.
const tokenRequest = async (settings, params) => {
  let resp;
  try {
    resp = await safeFetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: settings.google_oauth_client_id,
        client_secret: clientSecret(settings) || "",
        ...params,
      }).toString(),
      timeoutMs: 8000,
    });
  } catch {
    throw new MailError("transient", "gmail token request failed");
  }
  const t = await resp.json().catch(() => null);
  if (!resp.ok || !t?.access_token) {
    throw new MailError(resp.status === 400 || resp.status === 401 ? "auth" : "transient", "gmail token HTTP " + resp.status, { status: resp.status });
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || null,
    expiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    scopes: String(t.scope || GMAIL_SCOPES.join(" ")).split(/\s+/).filter(Boolean),
  };
};

export const exchange = ({ settings, code, redirectUri }) =>
  tokenRequest(settings, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refresh = ({ settings, refreshToken }) =>
  tokenRequest(settings, { grant_type: "refresh_token", refresh_token: refreshToken });

const QUOTA_RE = /dailyLimitExceeded|quotaExceeded/;
const RATE_RE = /rateLimitExceeded|userRateLimitExceeded/;
const base403 = (status, body) => {
  if (status === 401) return "auth";
  if (status === 403) return QUOTA_RE.test(body || "") ? "quota" : RATE_RE.test(body || "") ? "throttle" : "auth";
  if (status === 429) return "throttle";
  return null;
};
// history.list 404: the historyId is too old or invalid.
export const classifyHistory = (status, body) => base403(status, body) || (status === 404 ? "checkpoint" : null);
// messages.get 404: the message was deleted after it was listed.
const classifyGet = (status, body) => base403(status, body) || (status === 404 ? "gone" : null);

const get = async (run, token, url, classify) => {
  const resp = await mailFetch(run, url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } }, classify);
  return resp.json();
};

export const whoAmI = async (token, run) => {
  const p = await get(run, token, API + "/profile", base403);
  return { address: normAddr(p.emailAddress), displayName: null, providerUserId: normAddr(p.emailAddress) };
};

// shortcut: addresses are the tokens with an "@" in the header. A display name
// that itself contains an "@" would add a false address. Upgrade to an RFC 5322
// parser if a real header shows it.
const addrsIn = (v) => (String(v || "").match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map(normAddr);

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s) => String(s || "").replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);

const iso = (v) => {
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export const normalise = (m, address) => {
  const h = {};
  for (const x of m.payload?.headers || []) {
    const k = String(x.name || "").toLowerCase();
    if (!(k in h)) h[k] = x.value;
  }
  const labels = m.labelIds || [];
  return {
    provider: "gmail",
    providerId: m.id,
    internetMessageId: parseIdList(h["message-id"])[0] || null,
    conversationId: m.threadId || null,
    conversationIndex: null,
    inReplyTo: parseIdList(h["in-reply-to"])[0] || null,
    references: parseIdList(h.references),
    direction: labels.includes("SENT") ? "out" : "in",
    from: addrsIn(h.from)[0] || null,
    fromName: String(h.from || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || null,
    to: addrsIn(h.to),
    cc: addrsIn(h.cc),
    subject: h.subject || "",
    preview: decode(m.snippet).slice(0, 255),
    // shortcut: metadata has no part list; multipart/mixed is how mail with a
    // file attached is built. The verifier treats a false negative as ambiguous.
    hasAttachments: /multipart\/mixed/i.test(m.payload?.mimeType || ""),
    sentAt: h.date ? iso(h.date) : null,
    receivedAt: m.internalDate ? iso(Number(m.internalDate)) : null,
    autoSubmitted: h["auto-submitted"] || null,
    listUnsubscribe: h["list-unsubscribe"] || null,
    precedence: h.precedence || null,
    webLink: address
      ? "https://mail.google.com/mail/?authuser=" + encodeURIComponent(address) + "#all/" + encodeURIComponent(m.id)
      : null,
  };
};

const fetchMessages = async (run, token, ids, address) => {
  const out = [];
  const query = "format=metadata&" + HEADERS.map((x) => "metadataHeaders=" + encodeURIComponent(x)).join("&");
  for (const id of ids) {
    try {
      out.push(normalise(await get(run, token, API + "/messages/" + encodeURIComponent(id) + "?" + query, classifyGet), address));
    } catch (err) {
      if (err?.code !== "gone") throw err;
    }
  }
  return out;
};

const watched = (labels) => (labels || []).some((l) => l === "INBOX" || l === "SENT");

export const listPage = async (token, checkpoint, { sinceIso, pageSize: size, address }, run) => {
  const cp = checkpoint && typeof checkpoint === "object" ? checkpoint : null;

  if (!cp?.historyId || cp.mode === "list") {
    const historyId = cp?.historyId || (await get(run, token, API + "/profile", base403)).historyId;
    const q = new URLSearchParams({
      q: "after:" + Math.floor(Date.parse(sinceIso) / 1000) + " (in:inbox OR in:sent)",
      maxResults: String(size),
    });
    if (cp?.pageToken) q.set("pageToken", cp.pageToken);
    const list = await get(run, token, API + "/messages?" + q.toString(), base403);
    const messages = await fetchMessages(run, token, (list.messages || []).map((m) => m.id), address);
    const next = list.nextPageToken || null;
    return { messages, checkpoint: next ? { mode: "list", historyId, pageToken: next } : { historyId }, done: !next };
  }

  const q = new URLSearchParams({ startHistoryId: String(cp.historyId), historyTypes: "messageAdded", maxResults: String(size) });
  if (cp.pageToken) q.set("pageToken", cp.pageToken);
  const body = await get(run, token, API + "/history?" + q.toString(), classifyHistory);
  const ids = [...new Set((body.history || [])
    .flatMap((r) => r.messagesAdded || [])
    .map((x) => x.message)
    .filter((m) => m?.id && watched(m.labelIds))
    .map((m) => m.id))];
  const messages = await fetchMessages(run, token, ids, address);
  const next = body.nextPageToken || null;
  return {
    messages,
    checkpoint: next ? { historyId: cp.historyId, pageToken: next } : { historyId: String(body.historyId || cp.historyId) },
    done: !next,
  };
};

// The newest sent messages, for the onboarding check (1 + n requests).
export const sampleSent = async (token, run, n = 10) => {
  const list = await get(run, token, API + "/messages?" + new URLSearchParams({ labelIds: "SENT", maxResults: String(n) }).toString(), base403);
  return fetchMessages(run, token, (list.messages || []).map((m) => m.id), null);
};

export const webLink = (m) => m.webLink || null;
