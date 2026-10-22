// Outlook (Microsoft Graph) mailbox adapter, read only.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md section 5.1.
//
// Per-user delegated OAuth on the tenant's existing app registration
// (graph_tenant_id, graph_client_id, graph_client_secret_enc; migration 028).
// The tenant send connection in graph-client.js keeps its own scopes.
//
// Scopes: offline_access, User.Read, Mail.Read. Mail.ReadBasic is the least
// privilege for delta, but it hides bodyPreview and extended properties, and
// the verifier needs both.
//
// Sync: one delta round per folder (Inbox, Sent Items), changeType=created,
// with immutable IDs. The first request carries a receivedDateTime filter, and
// Graph keeps it in the delta token, so no round reads the whole history.

import {
  buildAuthorizeUrl, exchangeCode, refreshTokens, graphDecryptSecret,
} from "../graph-client.js";
import { MailError, mailFetch, normAddr, parseIdList } from "./provider.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.Read"];

const FOLDER_IDS = { inbox: "inbox", sent: "sentitems" };

const SELECT = [
  "id", "internetMessageId", "conversationId", "conversationIndex",
  "from", "toRecipients", "ccRecipients", "subject", "bodyPreview",
  "hasAttachments", "sentDateTime", "receivedDateTime", "webLink",
].join(",");

// The Sent Items copy has no internetMessageHeaders: the transport adds the
// headers after Outlook saves the copy. Outlook keeps In-Reply-To and
// References as MAPI properties on both folders. Not yet checked on a live
// mailbox (plan section 8, item 1); EA-8 adds the onboarding check.
const PS_INTERNET_HEADERS = "{00020386-0000-0000-C000-000000000046}";
const PROPS = {
  inReplyTo: "String 0x1042",
  references: "String 0x1039",
  autoSubmitted: "String " + PS_INTERNET_HEADERS + " Name Auto-Submitted",
  listUnsubscribe: "String " + PS_INTERNET_HEADERS + " Name List-Unsubscribe",
  precedence: "String " + PS_INTERNET_HEADERS + " Name Precedence",
};
const EXPAND = "singleValueExtendedProperties($filter="
  + Object.values(PROPS).map((id) => "id eq '" + id + "'").join(" or ") + ")";

export const isConfigured = (s) => !!(s?.graph_tenant_id && s?.graph_client_id && s?.graph_client_secret_enc);

// Token endpoint errors: 400 and 401 mean the grant is gone (revoked, expired,
// consent withdrawn). Anything else may pass.
const tokenError = (err) => new MailError(
  err?.status === 400 || err?.status === 401 ? "auth" : "transient",
  "outlook token HTTP " + (err?.status || 0),
  { status: err?.status || 0 },
);

const tokenResult = (t) => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token || null,
  expiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
  scopes: String(t.scope || OUTLOOK_SCOPES.join(" ")).split(/\s+/).filter(Boolean),
});

const appOf = (settings) => ({
  azureTenant: settings.graph_tenant_id,
  clientId: settings.graph_client_id,
  clientSecret: graphDecryptSecret(settings),
});

export const authorizeUrl = ({ settings, state, redirectUri }) => buildAuthorizeUrl({
  azureTenant: settings.graph_tenant_id, clientId: settings.graph_client_id,
  redirectUri, state, scopes: OUTLOOK_SCOPES,
});

export const exchange = async ({ settings, code, redirectUri }) => {
  try {
    return tokenResult(await exchangeCode({ ...appOf(settings), code, redirectUri, scopes: OUTLOOK_SCOPES }));
  } catch (err) { throw tokenError(err); }
};

export const refresh = async ({ settings, refreshToken }) => {
  try {
    return tokenResult(await refreshTokens({ ...appOf(settings), refreshToken, scopes: OUTLOOK_SCOPES }));
  } catch (err) { throw tokenError(err); }
};

const CHECKPOINT_BODY_RE = /syncStateNotFound|syncStateInvalid|resyncRequired|InvalidSyncState/i;
export const classify = (status, body) => {
  if (status === 401 || status === 403) return "auth";
  if (status === 410) return "checkpoint";
  if (status === 400 && CHECKPOINT_BODY_RE.test(body || "")) return "checkpoint";
  if (status === 429 || status === 503) return "throttle";
  return null;
};

const graphGet = async (run, token, url, prefer) => {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (prefer) headers.Prefer = prefer;
  const resp = await mailFetch(run, url, { headers }, classify);
  return resp.json();
};

export const whoAmI = async (token, run) => {
  const me = await graphGet(run, token, GRAPH + "/me?$select=id,mail,userPrincipalName,displayName");
  return {
    address: normAddr(me.mail || me.userPrincipalName),
    displayName: me.displayName || null,
    providerUserId: me.id || null,
  };
};

const addrList = (list) => (Array.isArray(list) ? list : [])
  .map((r) => normAddr(r?.emailAddress?.address)).filter(Boolean);

export const normalise = (m, folder) => {
  const props = {};
  for (const p of m.singleValueExtendedProperties || []) props[String(p.id || "").toLowerCase()] = p.value;
  const prop = (id) => props[id.toLowerCase()] ?? null;
  return {
    provider: "outlook",
    providerId: m.id,
    internetMessageId: m.internetMessageId || null,
    conversationId: m.conversationId || null,
    conversationIndex: m.conversationIndex || null,
    inReplyTo: parseIdList(prop(PROPS.inReplyTo))[0] || null,
    references: parseIdList(prop(PROPS.references)),
    direction: folder === "sent" ? "out" : "in",
    from: normAddr(m.from?.emailAddress?.address) || null,
    fromName: m.from?.emailAddress?.name || null,
    to: addrList(m.toRecipients),
    cc: addrList(m.ccRecipients),
    subject: m.subject || "",
    preview: String(m.bodyPreview || "").slice(0, 255),
    hasAttachments: !!m.hasAttachments,
    sentAt: m.sentDateTime || null,
    receivedAt: m.receivedDateTime || null,
    autoSubmitted: prop(PROPS.autoSubmitted),
    listUnsubscribe: prop(PROPS.listUnsubscribe),
    precedence: prop(PROPS.precedence),
    webLink: m.webLink || null,
  };
};

export const folders = ["inbox", "sent"];

// One page of one folder. The checkpoint is the Graph next or delta link. A
// stored link that is not a Graph mail-folder URL is ignored, so the sync never
// sends the token anywhere else.
export const listPage = async (token, checkpoint, { folder, sinceIso, pageSize }, run) => {
  let url = typeof checkpoint === "string" && checkpoint.startsWith(GRAPH + "/me/mailFolders") ? checkpoint : null;
  if (!url) {
    const q = new URLSearchParams({
      changeType: "created",
      $select: SELECT,
      $expand: EXPAND,
      $filter: "receivedDateTime ge " + sinceIso,
    });
    url = GRAPH + "/me/mailFolders/" + FOLDER_IDS[folder] + "/messages/delta?" + q.toString();
  }
  const body = await graphGet(run, token, url, 'IdType="ImmutableId", odata.maxpagesize=' + pageSize);
  const next = body["@odata.nextLink"] || null;
  const delta = body["@odata.deltaLink"] || null;
  const messages = (body.value || []).filter((m) => !m["@removed"] && m.id).map((m) => normalise(m, folder));
  return { messages, checkpoint: next || delta || url, done: !next };
};

export const webLink = (m) => m.webLink || null;
