// SAP S/4HANA OData v4 HTTP client.
//
// Auth: OAuth2 client_credentials against the customer's IAS tenant.
// Token cached in-memory by oauth2.js.
//
// All reads use OData v4 with $filter and $top/$skip pagination. The
// stable API path prefix is /sap/opu/odata4/sap/<service> for newer
// services (e.g. api_business_partner) or /sap/opu/odata/sap/ for
// legacy V2 (we deliberately use V4 here).

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";
import { safeFetch } from "./safe-fetch.js";

export const sapDecryptCreds = (settings) => {
  if (!settings) return settings;
  const out = { ...settings };
  const tryDec = (encCol, plainCol) => {
    if (settings[encCol] && settings.sap_creds_iv) {
      try { return decryptField(settings[encCol], settings.sap_creds_iv); }
      catch (_e) { return settings[plainCol] || null; }
    }
    return settings[plainCol] || null;
  };
  out.sap_client_id = tryDec("sap_client_id_enc", "sap_client_id");
  out.sap_client_secret = tryDec("sap_client_secret_enc", null);
  return out;
};

export const sapEncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return { sap_client_id: client_id, sap_client_id_enc: null, sap_client_secret_enc: null, sap_creds_iv: null };
  }
  const iv = newIv();
  return {
    sap_client_id: null,
    sap_client_id_enc: encryptField(client_id, iv),
    sap_client_secret_enc: encryptField(client_secret, iv),
    sap_creds_iv: iv,
  };
};

export const sapIsConfigured = (settings) => !!(
  settings?.sap_base_url && settings?.sap_token_url &&
  settings?.sap_client_id && settings?.sap_client_secret
);

const acquireToken = async (settings) => {
  return oauth2ClientCredentials({
    tenantId: settings.tenant_id || "shared",
    tokenUrl: settings.sap_token_url,
    clientId: settings.sap_client_id,
    clientSecret: settings.sap_client_secret,
    scope: "API_BUSINESS_PARTNER_0001 API_MATERIAL_DOCUMENT_SRV_0001 API_SALES_ORDER_SRV_0001 API_PURCHASEORDER_PROCESS_SRV_0001",
  });
};

export const sapFetch = async (settings, { method, path, body, query, retryOn401 = true } = {}) => {
  if (!sapIsConfigured(settings)) {
    throw new Error("SAP not configured for this tenant");
  }
  const token = await acquireToken(settings);
  const url = settings.sap_base_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await safeFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(settings.tenant_id || "shared", settings.sap_token_url, settings.sap_client_id);
    return sapFetch(settings, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

// Helper: paginated OData list. Returns the merged value array.
export const sapList = async (settings, path, { filter, top = 200, maxRows = 5000, expand } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    if (expand) query.$expand = expand;
    const resp = await sapFetch(settings, { method: "GET", path, query });
    if (!resp.ok) {
      const detail = JSON.stringify(resp.body).slice(0, 400);
      throw new Error("SAP list " + resp.status + " " + path + " " + detail);
    }
    const items = resp.body?.value || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};
