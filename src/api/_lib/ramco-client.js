// Ramco ERP REST client.
//
// Auth: OAuth2 client_credentials. Token endpoint and credentials
// are issued via the Ramco developer portal (developer.ramco.com)
// and registered against a tenant deployment. Client credentials
// rotate on schedule per Ramco's policy; the encrypted-at-rest
// column lets us replace them without dropping cron-driven sync.
//
// Wire shape:
//   <base_url>/<tenant_org>/api/v1/<resource>
// Cursor-based filters use a `lastModifiedAfter` query param; result
// envelopes wrap the rows in a `{ data: [...], pagination: { ... } }`
// shape that matches Ramco's published v2 docs. We accept both the
// v1 shape (`results`) and the v2 shape (`data`).

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";

export const ramcoDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.ramco_creds_iv) {
      try { return decryptField(s[encCol], s.ramco_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.ramco_client_id = tryDec("ramco_client_id_enc", "ramco_client_id");
  out.ramco_client_secret = tryDec("ramco_client_secret_enc", null);
  return out;
};

export const ramcoEncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return {
      ramco_client_id: client_id,
      ramco_client_id_enc: null,
      ramco_client_secret_enc: null,
      ramco_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    ramco_client_id: null,
    ramco_client_id_enc: encryptField(client_id, iv),
    ramco_client_secret_enc: encryptField(client_secret, iv),
    ramco_creds_iv: iv,
  };
};

export const ramcoIsConfigured = (s) => !!(
  s?.ramco_base_url && s?.ramco_token_url && s?.ramco_client_id && s?.ramco_client_secret
);

const acquireToken = async (s) => oauth2ClientCredentials({
  tenantId: s.tenant_id || "shared",
  tokenUrl: s.ramco_token_url,
  clientId: s.ramco_client_id,
  clientSecret: s.ramco_client_secret,
  scope: s.ramco_scope || "api",
});

const ramcoUrl = (s, resource, query = {}) => {
  const orgUnit = s.ramco_org_unit || "default";
  const base = s.ramco_base_url.replace(/\/+$/, "");
  const url = new URL(base + "/" + orgUnit + "/api/v1/" + resource);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const ramcoFetch = async (s, { method = "GET", resource, body, query, retryOn401 = true } = {}) => {
  if (!ramcoIsConfigured(s)) throw new Error("Ramco not configured for this tenant");
  const token = await acquireToken(s);
  const url = ramcoUrl(s, resource, query);
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
  };
  if (s.ramco_company) headers["X-Ramco-Company"] = s.ramco_company;
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.ramco_token_url, s.ramco_client_id);
    return ramcoFetch(s, { method, resource, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const ramcoProbe = async (s) => ramcoFetch(s, {
  method: "GET", resource: "Sales/SalesOrder", query: { pageSize: 1 },
});

// Pagination: Ramco exposes pageNumber + pageSize. The response
// envelope is `{ data: [...], pagination: { totalCount, pageNumber } }`
// in v2 and `{ results: [...] }` in v1. We probe both shapes.
export const ramcoList = async (s, resource, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let pageNumber = 1;
  while (out.length < maxRows) {
    const query = { pageSize: String(top), pageNumber: String(pageNumber) };
    if (filter) query.filter = filter;
    const resp = await ramcoFetch(s, { method: "GET", resource, query });
    if (!resp.ok) {
      throw new Error("Ramco list " + resp.status + " " + resource + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.data || resp.body?.results || resp.body?.value || [];
    out.push(...items);
    if (items.length < top) break;
    pageNumber += 1;
  }
  return out;
};

export const ramcoPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    LineNumber: i + 1,
    PartNumber: ln.itemCode || ln.partNumber || ln.sku,
    Quantity: Number(ln.quantity || ln.qty || 1),
    UnitPrice: Number(ln.unitPrice || ln.rate || 0),
    UnitOfMeasure: ln.uom || "EA",
  }));
  const payload = {
    SalesOrderNumber: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    CustomerCode: customer.external_ref?.ramco?.customer_code || customer.customer_key || customer.id,
    Currency: result.currency || "USD",
    OrderDate: new Date().toISOString().slice(0, 10),
    OrderType: fieldMap.order_type || "Standard",
    OrgUnit: s.ramco_org_unit || fieldMap.org_unit || null,
    Lines: lines,
  };
  const resp = await ramcoFetch(s, { method: "POST", resource: "Sales/SalesOrder", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.SalesOrderNumber || resp.body?.salesOrderNumber || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
