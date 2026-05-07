// Acumatica Cloud ERP REST client.
//
// Auth: cookie session.
//   POST /entity/auth/login  body { name, password, company, branch }
//   -> Set-Cookie ASP.NET_SessionId=...; .ASPXAUTH=...
//   <call entity endpoints with the cookie>
//   POST /entity/auth/logout
//
// We hold the cookie in-memory per (tenant_id, base_url, username),
// transparently re-authing on 401. Acumatica's session timeouts are
// short (default ~30 minutes), so we re-mint freely.
//
// Entity reads use /entity/<endpoint_name>/<endpoint_version>/<entity>
// e.g. /entity/Default/20.200.001/Customer
//
// Filtering uses OData $filter; cursoring on LastModifiedDateTime.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

const sessionCache = new Map();
const cacheKey = (tid, base, user) => `${tid}|${base}|${user}`;

export const acuDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.acumatica_creds_iv) {
      try { return decryptField(s[encCol], s.acumatica_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.acumatica_username = tryDec("acumatica_username_enc", "acumatica_username");
  out.acumatica_password = tryDec("acumatica_password_enc", null);
  return out;
};

export const acuEncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return { acumatica_username: username, acumatica_username_enc: null, acumatica_password_enc: null, acumatica_creds_iv: null };
  }
  const iv = newIv();
  return {
    acumatica_username: null,
    acumatica_username_enc: encryptField(username, iv),
    acumatica_password_enc: encryptField(password, iv),
    acumatica_creds_iv: iv,
  };
};

export const acuIsConfigured = (s) => !!(
  s?.acumatica_base_url && s?.acumatica_username && s?.acumatica_password
);

const login = async (s) => {
  const url = s.acumatica_base_url.replace(/\/+$/, "") + "/entity/auth/login";
  const resp = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      name: s.acumatica_username,
      password: s.acumatica_password,
      company: s.acumatica_company || "",
      branch: s.acumatica_branch || "",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error("Acumatica login failed: " + resp.status + " " + text.slice(0, 200));
    err.status = resp.status;
    throw err;
  }
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie()
    : (resp.headers.raw ? resp.headers.raw()["set-cookie"] || [] : []);
  const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies]).filter(Boolean)
    .map((c) => c.split(";")[0]).join("; ");
  return cookie;
};

const ensureSession = async (s) => {
  const key = cacheKey(s.tenant_id || "shared", s.acumatica_base_url, s.acumatica_username);
  const cached = sessionCache.get(key);
  if (cached) return cached;
  const cookie = await login(s);
  sessionCache.set(key, cookie);
  return cookie;
};

const evictSession = (s) => {
  sessionCache.delete(cacheKey(s.tenant_id || "shared", s.acumatica_base_url, s.acumatica_username));
};

export const acuFetch = async (s, { method, path, body, query, retryOn401 = true } = {}) => {
  if (!acuIsConfigured(s)) throw new Error("Acumatica not configured for this tenant");
  const cookie = await ensureSession(s);
  const url = s.acumatica_base_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const headers = {
    Accept: "application/json",
    Cookie: cookie,
  };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await safeFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (resp.status === 401 && retryOn401) {
    evictSession(s);
    return acuFetch(s, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const acuList = async (s, entity, { filter, top = 200, maxRows = 5000, expand } = {}) => {
  const ep = s.acumatica_endpoint_name || "Default";
  const ver = s.acumatica_endpoint_version || "20.200.001";
  const path = `/entity/${ep}/${ver}/${entity}`;
  const query = { $top: String(top) };
  if (filter) query.$filter = filter;
  if (expand) query.$expand = expand;
  const resp = await acuFetch(s, { method: "GET", path, query });
  if (!resp.ok) {
    throw new Error("Acumatica list " + resp.status + " " + entity + ": " + JSON.stringify(resp.body).slice(0, 400));
  }
  // Acumatica returns an array directly (not OData wrapped).
  return Array.isArray(resp.body) ? resp.body.slice(0, maxRows) : [];
};
