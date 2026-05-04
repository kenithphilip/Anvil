// Epicor Prophet 21 REST/OData client.
//
// Auth: P21 issues a session token via POST /api/security/token with
// Basic auth (or X-Username + X-Password headers depending on the
// host's REST configuration). The token is short-lived; we cache it
// in-memory and refresh on 401.
//
// Reads use OData v2-style /api/v2/odata/data/<EntitySet>?$filter=...
// Writes use /api/v2/data/<entity> (P21's REST mutation surface).

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

const tokenCache = new Map();
const REFRESH_SLACK_MS = 30_000;

const cacheKey = (s) => `${s.tenant_id || "shared"}|${s.p21_base_url}|${s.p21_username}`;

export const p21DecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.p21_creds_iv) {
      try { return decryptField(s[encCol], s.p21_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.p21_username = tryDec("p21_username_enc", "p21_username");
  out.p21_password = tryDec("p21_password_enc", null);
  return out;
};

export const p21EncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return { p21_username: username, p21_username_enc: null, p21_password_enc: null, p21_creds_iv: null };
  }
  const iv = newIv();
  return {
    p21_username: null,
    p21_username_enc: encryptField(username, iv),
    p21_password_enc: encryptField(password, iv),
    p21_creds_iv: iv,
  };
};

export const p21IsConfigured = (s) => !!(
  s?.p21_base_url && s?.p21_username && s?.p21_password
);

const acquireToken = async (s) => {
  const key = cacheKey(s);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SLACK_MS) return cached.token;
  const url = s.p21_base_url.replace(/\/+$/, "") + "/api/security/token";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Username: s.p21_username,
      Password: s.p21_password,
      ...(s.p21_company_id ? { "CompanyID": s.p21_company_id } : {}),
    },
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  if (!resp.ok || !parsed?.AccessToken) {
    const err = new Error("P21 token: " + resp.status + " " + (parsed?.error || parsed?.raw || ""));
    err.status = resp.status;
    throw err;
  }
  // Tokens default to ~30 minutes; if API returns Expiration, use it.
  const ttlMs = (Number(parsed.ExpirationMinutes) || 30) * 60_000;
  tokenCache.set(key, { token: parsed.AccessToken, expiresAt: Date.now() + ttlMs });
  return parsed.AccessToken;
};

export const p21Fetch = async (s, { method, path, body, query, retryOn401 = true } = {}) => {
  if (!p21IsConfigured(s)) throw new Error("Prophet 21 not configured for this tenant");
  const token = await acquireToken(s);
  const url = s.p21_base_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (resp.status === 401 && retryOn401) {
    tokenCache.delete(cacheKey(s));
    return p21Fetch(s, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const p21List = async (s, path, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    const resp = await p21Fetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("P21 list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.value || resp.body?.Items || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};
