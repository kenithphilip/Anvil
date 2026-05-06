// Plex Smart Manufacturing Platform (Rockwell Automation) REST client.
//
// Auth: API-key. Customer-facing API keys are issued from the Staff
// Panel and accompany every call as a basic-auth header (username =
// API key, password = empty), with the customer/PCN id as a custom
// header. We model both styles since the platform supports either:
//   - REST APIs at https://api.plex.com/<scope>/v1/...
//     headers: Authorization: Basic <base64(api_key:)>
//             X-Plex-Customer-Id: <numeric customer id>
//             X-Plex-PCN: <plant control number, optional>
//
// Tokens here are essentially long-lived bearer credentials, so we
// don't use token-cache.js. We do encrypt the API key at rest.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

export const plexDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol) => {
    if (s[encCol] && s.plex_creds_iv) {
      try { return decryptField(s[encCol], s.plex_creds_iv); }
      catch (_e) { return null; }
    }
    return null;
  };
  out.plex_api_key = tryDec("plex_api_key_enc");
  return out;
};

export const plexEncryptCreds = ({ api_key }) => {
  if (!isSecretsConfigured()) {
    return {
      plex_api_key_enc: null,
      plex_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    plex_api_key_enc: encryptField(api_key, iv),
    plex_creds_iv: iv,
  };
};

export const plexIsConfigured = (s) => !!(
  s?.plex_base_url && s?.plex_customer_id && s?.plex_api_key
);

const apiUrl = (s, path, query = {}) => {
  const url = new URL(s.plex_base_url.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

const basicAuth = (apiKey) =>
  "Basic " + Buffer.from(String(apiKey) + ":").toString("base64");

export const plexFetch = async (s, { method = "GET", path, body, query } = {}) => {
  if (!plexIsConfigured(s)) throw new Error("Plex not configured for this tenant");
  const url = apiUrl(s, path, query);
  const headers = {
    Authorization: basicAuth(s.plex_api_key),
    Accept: "application/json",
    "X-Plex-Customer-Id": String(s.plex_customer_id),
  };
  if (s.plex_pcn) headers["X-Plex-PCN"] = String(s.plex_pcn);
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await safeFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

export const plexProbe = async (s) => plexFetch(s, {
  method: "GET", path: "/scm/v1/customers", query: { pageSize: 1 },
});

// Plex pagination uses pageSize + page. Items typically appear on
// `data` or `value` depending on the resource family.
export const plexList = async (s, path, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let page = 1;
  while (out.length < maxRows) {
    const query = { pageSize: String(top), page: String(page) };
    if (filter) query.filter = filter;
    const resp = await plexFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("Plex list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.data || resp.body?.value || resp.body || [];
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < top) break;
    page += 1;
  }
  return out;
};

// Plex Sales Order create. The exact resource family depends on
// the customer's industry pack (manufacturing vs distribution). We
// use the SCM v1 sales-orders resource which is the documented
// public surface.
export const plexPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    lineNumber: i + 1,
    partNumber: ln.itemCode || ln.partNumber || ln.sku,
    quantity: Number(ln.quantity || ln.qty || 1),
    unitPrice: Number(ln.unitPrice || ln.rate || 0),
    unitOfMeasure: ln.uom || "EA",
  }));
  const payload = {
    salesOrderNumber: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    customerCode: customer.external_ref?.plex?.customer_code || customer.customer_key || customer.id,
    customerPurchaseOrder: anvilOrder.po_number || null,
    currency: result.currency || "USD",
    orderDate: new Date().toISOString().slice(0, 10),
    salesOrderType: fieldMap.order_type || "Standard",
    pcn: s.plex_pcn || fieldMap.pcn || null,
    lines,
  };
  const resp = await plexFetch(s, { method: "POST", path: "/scm/v1/sales-orders", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.salesOrderNumber || resp.body?.salesOrderKey || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
