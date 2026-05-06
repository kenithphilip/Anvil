// Oracle Fusion Cloud ERP REST client.
//
// Auth: OAuth2 client_credentials via OCI IDCS (or Identity Domain).
// The client_id is registered as a Fusion Apps user in the Security
// Console — username must match client_id exactly. Token endpoint
// looks like:
//   https://idcs-<id>.identity.oraclecloud.com/oauth2/v1/token
// Scope is the Fusion Apps service URL with the suffix 'urn:opc:resource:consumer::all'
// or the more granular 'urn:opc:resource:fusion:apps:read|write'.
//
// Wire shape (Fusion REST):
//   <base_url>/fscmRestApi/resources/<version>/<resource>
// Examples used here:
//   resource=salesOrdersForOrderHub  Sales orders (write)
//   resource=accounts                Customers
//   resource=itemsV2                 Items
//
// Per Oracle's published recommendation: limit POST batches to <=500
// records. Our payload is per-order so this is a hard ceiling, not a
// throttle.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";
import { safeFetch } from "./safe-fetch.js";

export const oracleFusionDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.oracle_fusion_creds_iv) {
      try { return decryptField(s[encCol], s.oracle_fusion_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.oracle_fusion_client_id = tryDec("oracle_fusion_client_id_enc", "oracle_fusion_client_id");
  out.oracle_fusion_client_secret = tryDec("oracle_fusion_client_secret_enc", null);
  return out;
};

export const oracleFusionEncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return {
      oracle_fusion_client_id: client_id,
      oracle_fusion_client_id_enc: null,
      oracle_fusion_client_secret_enc: null,
      oracle_fusion_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    oracle_fusion_client_id: null,
    oracle_fusion_client_id_enc: encryptField(client_id, iv),
    oracle_fusion_client_secret_enc: encryptField(client_secret, iv),
    oracle_fusion_creds_iv: iv,
  };
};

export const oracleFusionIsConfigured = (s) => !!(
  s?.oracle_fusion_base_url && s?.oracle_fusion_token_url &&
  s?.oracle_fusion_client_id && s?.oracle_fusion_client_secret
);

const acquireToken = async (s) => oauth2ClientCredentials({
  tenantId: s.tenant_id || "shared",
  tokenUrl: s.oracle_fusion_token_url,
  clientId: s.oracle_fusion_client_id,
  clientSecret: s.oracle_fusion_client_secret,
  scope: s.oracle_fusion_scope || "urn:opc:resource:consumer::all",
});

const fusionUrl = (s, resource, query = {}) => {
  const version = s.oracle_fusion_api_version || "11.13.18.05";
  const base = s.oracle_fusion_base_url.replace(/\/+$/, "");
  const url = new URL(base + "/fscmRestApi/resources/" + version + "/" + resource);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const oracleFusionFetch = async (s, { method = "GET", resource, body, query, retryOn401 = true } = {}) => {
  if (!oracleFusionIsConfigured(s)) throw new Error("Oracle Fusion not configured for this tenant");
  const token = await acquireToken(s);
  const url = fusionUrl(s, resource, query);
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    // Oracle's REST docs require this header for write ops to opt
    // into structured failure responses with error codes.
    "REST-Framework-Version": "4",
  };
  if (body) headers["Content-Type"] = "application/vnd.oracle.adf.resourceitem+json";
  const t0 = Date.now();
  const resp = await safeFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.oracle_fusion_token_url, s.oracle_fusion_client_id);
    return oracleFusionFetch(s, { method, resource, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const oracleFusionProbe = async (s) => oracleFusionFetch(s, {
  method: "GET", resource: "salesOrdersForOrderHub", query: { limit: 1 },
});

// Fusion REST pagination: ?limit=<n>&offset=<m>. Items in `items[]`,
// `hasMore` boolean signals whether to continue.
export const oracleFusionList = async (s, resource, { q, fields, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let offset = 0;
  while (out.length < maxRows) {
    const query = { limit: String(top), offset: String(offset), totalResults: "true" };
    if (q) query.q = q;
    if (fields) query.fields = fields;
    const resp = await oracleFusionFetch(s, { method: "GET", resource, query });
    if (!resp.ok) {
      throw new Error("Oracle Fusion list " + resp.status + " " + resource + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.items || [];
    out.push(...items);
    if (!resp.body?.hasMore || items.length < top) break;
    offset += top;
  }
  return out;
};

export const oracleFusionPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    SourceTransactionLineId: String(i + 1),
    SourceTransactionLineNumber: String(i + 1),
    ProductNumber: ln.itemCode || ln.partNumber || ln.sku,
    OrderedQuantity: Number(ln.quantity || ln.qty || 1),
    UnitListPrice: Number(ln.unitPrice || ln.rate || 0),
    OrderedUOMCode: ln.uom || "Ea",
  }));
  const payload = {
    SourceTransactionNumber: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    SourceTransactionSystem: fieldMap.source_system || "ANVIL",
    BuyingPartyNumber: customer.external_ref?.oracle_fusion?.party_number || customer.customer_key || customer.id,
    BusinessUnitName: s.oracle_fusion_business_unit || fieldMap.business_unit || null,
    TransactionalCurrencyCode: result.currency || "USD",
    TransactionTypeCode: fieldMap.transaction_type || "STD",
    RequestedShipDate: result.requestedShipDate || new Date().toISOString().slice(0, 10),
    lines,
  };
  const resp = await oracleFusionFetch(s, { method: "POST", resource: "salesOrdersForOrderHub", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.OrderNumber || resp.body?.HeaderId || resp.body?.SourceTransactionNumber || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
