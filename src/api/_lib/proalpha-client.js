// proALPHA ERP REST client.
//
// Auth: HTTP Basic over HTTPS. Some deployments add an OAuth2 layer
// in front of the BC-REST-API module; we default to Basic since it
// is the lowest common denominator and works on every supported
// proALPHA version.
//
// Wire shape:
//   <base_url>/api/v1/<resource>
// `proalpha_company` (optional) is sent as `X-Proalpha-Company`
// to pin requests to a multi-company tenant.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

export const proalphaDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.proalpha_creds_iv) {
      try { return decryptField(s[encCol], s.proalpha_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.proalpha_username = tryDec("proalpha_username_enc", "proalpha_username");
  out.proalpha_password = tryDec("proalpha_password_enc", null);
  return out;
};

export const proalphaEncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return {
      proalpha_username: username,
      proalpha_username_enc: null,
      proalpha_password_enc: null,
      proalpha_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    proalpha_username: null,
    proalpha_username_enc: encryptField(username, iv),
    proalpha_password_enc: encryptField(password, iv),
    proalpha_creds_iv: iv,
  };
};

export const proalphaIsConfigured = (s) => !!(
  s?.proalpha_base_url && s?.proalpha_username && s?.proalpha_password
);

const basicAuth = (u, p) =>
  "Basic " + Buffer.from(String(u) + ":" + String(p)).toString("base64");

const apiUrl = (s, path, query = {}) => {
  const url = new URL(s.proalpha_base_url.replace(/\/+$/, "") + "/api/v1/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const proalphaFetch = async (s, { method = "GET", path, body, query } = {}) => {
  if (!proalphaIsConfigured(s)) throw new Error("proALPHA not configured for this tenant");
  const url = apiUrl(s, path, query);
  const headers = {
    Authorization: basicAuth(s.proalpha_username, s.proalpha_password),
    Accept: "application/json",
  };
  if (s.proalpha_company) headers["X-Proalpha-Company"] = s.proalpha_company;
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

export const proalphaProbe = async (s) => proalphaFetch(s, {
  method: "GET", path: "customer", query: { limit: 1 },
});

export const proalphaList = async (s, path, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let offset = 0;
  while (out.length < maxRows) {
    const query = { limit: String(top), offset: String(offset) };
    if (filter) query.filter = filter;
    const resp = await proalphaFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("proALPHA list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.data || resp.body?.results || resp.body?.value || [];
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < top) break;
    offset += top;
  }
  return out;
};

export const proalphaPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    lineNumber: i + 1,
    article: ln.itemCode || ln.partNumber || ln.sku,
    quantity: Number(ln.quantity || ln.qty || 1),
    unitPrice: Number(ln.unitPrice || ln.rate || 0),
    unitOfMeasure: ln.uom || "ST",
  }));
  const payload = {
    orderNumber: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    customer: customer.external_ref?.proalpha?.customer_number || customer.customer_key || customer.id,
    currency: result.currency || "EUR",
    orderDate: new Date().toISOString().slice(0, 10),
    orderType: fieldMap.order_type || "S1",
    lines,
  };
  const resp = await proalphaFetch(s, { method: "POST", path: "salesOrder", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.orderNumber || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
