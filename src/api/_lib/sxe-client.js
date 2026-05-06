// Infor SX.e (Distribution SX.e) client.
//
// Auth: Infor ION API gateway with OAuth2 client_credentials. We
// reuse the shared oauth2 helper to mint + cache tokens.
// Endpoint pattern: /<tenant>/M3/m3api-rest/v2/<entity> for read,
// /<tenant>/SXE/<entity> for write APIs that some hosts expose.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";
import { safeFetch } from "./safe-fetch.js";

export const sxeDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.sxe_creds_iv) {
      try { return decryptField(s[encCol], s.sxe_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.sxe_client_id = tryDec("sxe_client_id_enc", "sxe_client_id");
  out.sxe_client_secret = tryDec("sxe_client_secret_enc", null);
  return out;
};

export const sxeEncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return { sxe_client_id: client_id, sxe_client_id_enc: null, sxe_client_secret_enc: null, sxe_creds_iv: null };
  }
  const iv = newIv();
  return {
    sxe_client_id: null,
    sxe_client_id_enc: encryptField(client_id, iv),
    sxe_client_secret_enc: encryptField(client_secret, iv),
    sxe_creds_iv: iv,
  };
};

export const sxeIsConfigured = (s) => !!(
  s?.sxe_base_url && s?.sxe_token_url && s?.sxe_client_id && s?.sxe_client_secret
);

const acquireToken = async (s) => oauth2ClientCredentials({
  tenantId: s.tenant_id || "shared",
  tokenUrl: s.sxe_token_url,
  clientId: s.sxe_client_id,
  clientSecret: s.sxe_client_secret,
  scope: "ION",
});

export const sxeFetch = async (s, { method, path, body, query, retryOn401 = true } = {}) => {
  if (!sxeIsConfigured(s)) throw new Error("SX.e not configured for this tenant");
  const token = await acquireToken(s);
  const url = s.sxe_base_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    ...(s.sxe_company ? { "X-Infor-Company": s.sxe_company } : {}),
  };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await safeFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.sxe_token_url, s.sxe_client_id);
    return sxeFetch(s, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const sxeList = async (s, path, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    const resp = await sxeFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("SX.e list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.value || resp.body?.records || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};
