// IFS Cloud REST client.
//
// Auth: OAuth2 client_credentials via IFS IAM. Token endpoint and
// client credentials live on per-tenant `ifs_*` columns of
// tenant_settings. The same `_lib/oauth2.js` cache used by Sage X3,
// SAP, D365 carries over verbatim.
//
// Wire shape (IFS Cloud OData v4 projection API):
//   <base_url>/main/ifsapplications/projection/v1/<projection>/<entity>
// where <projection> is a domain projection like "CustomerOrder.svc"
// (sales orders) or "CustomerInfo.svc" (customers). Filter syntax is
// OData v4 ($filter / $top / $skip / $select). Cursor field names
// follow IFS LU naming: `LastUpdate` on the wire maps to camel-case
// `lastUpdate` in the projection. Either form is accepted; we use
// camel-case to match what API Explorer emits.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";
import { safeFetch } from "./safe-fetch.js";

export const ifsDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.ifs_creds_iv) {
      try { return decryptField(s[encCol], s.ifs_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.ifs_client_id = tryDec("ifs_client_id_enc", "ifs_client_id");
  out.ifs_client_secret = tryDec("ifs_client_secret_enc", null);
  return out;
};

export const ifsEncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return {
      ifs_client_id: client_id,
      ifs_client_id_enc: null,
      ifs_client_secret_enc: null,
      ifs_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    ifs_client_id: null,
    ifs_client_id_enc: encryptField(client_id, iv),
    ifs_client_secret_enc: encryptField(client_secret, iv),
    ifs_creds_iv: iv,
  };
};

export const ifsIsConfigured = (s) => !!(
  s?.ifs_base_url && s?.ifs_token_url && s?.ifs_client_id && s?.ifs_client_secret
);

const acquireToken = async (s) => oauth2ClientCredentials({
  tenantId: s.tenant_id || "shared",
  tokenUrl: s.ifs_token_url,
  clientId: s.ifs_client_id,
  clientSecret: s.ifs_client_secret,
  scope: s.ifs_scope || "openid profile INTEGRATION",
});

// Compose the IFS projection URL. The projection module (e.g.
// "CustomerOrder.svc") is configurable per tenant since IFS
// deployments often namespace projections per company.
const projectionUrl = (s, entity, query = {}) => {
  const projection = s.ifs_projection || "CustomerOrder.svc";
  const base = s.ifs_base_url.replace(/\/+$/, "");
  const url = new URL(base + "/main/ifsapplications/projection/v1/" + projection + "/" + entity);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const ifsFetch = async (s, { method = "GET", entity, body, query, retryOn401 = true } = {}) => {
  if (!ifsIsConfigured(s)) throw new Error("IFS Cloud not configured for this tenant");
  const token = await acquireToken(s);
  const url = projectionUrl(s, entity, query);
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    // IFS uses an `If-Match` header for ETag-protected updates; we
    // send "*" for our generic upsert path. Reads ignore it.
    "If-Match": "*",
  };
  if (body) headers["Content-Type"] = "application/json";
  if (s.ifs_company) headers["IFS-Company"] = s.ifs_company;
  const t0 = Date.now();
  const resp = await safeFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.ifs_token_url, s.ifs_client_id);
    return ifsFetch(s, { method, entity, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

// Probe: cheapest authenticated call. Read $top=1 from the orders
// collection. Falls back to the customer collection when sales-order
// projection is mis-configured.
export const ifsProbe = async (s) => {
  const r = await ifsFetch(s, { method: "GET", entity: "CustomerOrders", query: { $top: 1 } });
  if (r.status === 404) {
    return ifsFetch(s, { method: "GET", entity: "Customers", query: { $top: 1 } });
  }
  return r;
};

// OData v4 paginated list. IFS responses follow OData spec: the
// records are under `value`, and a `@odata.nextLink` carries the
// next page cursor. We loop until `value` is empty or maxRows is hit.
export const ifsList = async (s, entity, { filter, select, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    if (select) query.$select = select;
    const resp = await ifsFetch(s, { method: "GET", entity, query });
    if (!resp.ok) {
      throw new Error("IFS list " + resp.status + " " + entity + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.value || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};

// Push a Customer Order. IFS expects a structured projection payload
// with header-level fields (CustomerNo, CurrencyCode, OrderDate) and
// a `SalesOrderLines` collection. The exact schema is published in
// the API Explorer; our payload covers the documented required
// fields and lets `ifs_field_map` override per-tenant overlays.
export const ifsPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    LineNo: String(i + 1),
    CatalogNo: ln.itemCode || ln.partNumber || ln.sku,
    BuyQtyDue: Number(ln.quantity || ln.qty || 1),
    SalesPrice: Number(ln.unitPrice || ln.rate || 0),
    SalesUnitMeas: ln.uom || "pcs",
  }));
  const payload = {
    OrderNo: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    CustomerNo: customer.external_ref?.ifs?.customer_no || customer.customer_key || customer.id,
    Currency: result.currency || "USD",
    WantedDeliveryDate: result.wantedDeliveryDate || new Date().toISOString().slice(0, 10),
    OrderType: fieldMap.order_type || "NO",
    SalesOrderLines: lines,
  };
  const resp = await ifsFetch(s, { method: "POST", entity: "CustomerOrders", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.OrderNo || resp.body?.Objkey || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
