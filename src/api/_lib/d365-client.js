// Microsoft Dynamics 365 F&O OData client.
//
// Auth: Azure AD OAuth2 client_credentials. The token is requested
// against /<tenant_id>/oauth2/token with `resource=<env_url>` (the
// older-style endpoint accepted by F&O; newer SaaS environments also
// accept v2.0 with scope=<env_url>/.default).
//
// Reads use OData /data/<EntitySet>?cross-company=true&$filter=...

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";
import { safeFetch } from "./safe-fetch.js";

export const d365DecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.d365_creds_iv) {
      try { return decryptField(s[encCol], s.d365_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.d365_client_id = tryDec("d365_client_id_enc", "d365_client_id");
  out.d365_client_secret = tryDec("d365_client_secret_enc", null);
  return out;
};

export const d365EncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return { d365_client_id: client_id, d365_client_id_enc: null, d365_client_secret_enc: null, d365_creds_iv: null };
  }
  const iv = newIv();
  return {
    d365_client_id: null,
    d365_client_id_enc: encryptField(client_id, iv),
    d365_client_secret_enc: encryptField(client_secret, iv),
    d365_creds_iv: iv,
  };
};

export const d365IsConfigured = (s) => !!(
  s?.d365_resource_url && s?.d365_token_url && s?.d365_client_id && s?.d365_client_secret
);

const acquireToken = async (s) => {
  // Use resource= form which the F&O OAuth2 endpoint expects.
  return oauth2ClientCredentials({
    tenantId: s.tenant_id || "shared",
    tokenUrl: s.d365_token_url,
    clientId: s.d365_client_id,
    clientSecret: s.d365_client_secret,
    resource: s.d365_resource_url,
  });
};

export const d365Fetch = async (s, { method, path, body, query, retryOn401 = true } = {}) => {
  if (!d365IsConfigured(s)) throw new Error("D365 not configured for this tenant");
  const token = await acquireToken(s);
  const url = s.d365_resource_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const headers = { Authorization: "Bearer " + token, Accept: "application/json", "OData-Version": "4.0" };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await safeFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.d365_token_url, s.d365_client_id);
    return d365Fetch(s, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

// Paginated list. F&O entities use $skip/$top; cross-company forces
// pulling rows from all DataAreaIds the auth principal can see.
export const d365List = async (s, path, { filter, top = 200, maxRows = 5000, crossCompany = false } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    if (crossCompany) query["cross-company"] = "true";
    const resp = await d365Fetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("D365 list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.value || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};
