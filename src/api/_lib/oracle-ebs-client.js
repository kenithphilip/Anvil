// Oracle E-Business Suite (Integrated SOA Gateway, ISG REST) client.
//
// Auth: HTTP Basic over HTTPS. ISG REST services are deployed from
// the EBS Integration Repository as PL/SQL APIs exposed at
//   <host>/webservices/rest/<service>/<method>
// Sales orders go through OE_ORDER_PUB.Process_Order; the underlying
// business event raises HEADER_ID + STATUS for reverse sync.
//
// Per-tenant settings carry username + password (encrypted at rest)
// plus a responsibility (e.g. "Order Management Super User") and
// org_id for the operating unit. Both are sent as headers on every
// call.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

export const oracleEbsDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.oracle_ebs_creds_iv) {
      try { return decryptField(s[encCol], s.oracle_ebs_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.oracle_ebs_username = tryDec("oracle_ebs_username_enc", "oracle_ebs_username");
  out.oracle_ebs_password = tryDec("oracle_ebs_password_enc", null);
  return out;
};

export const oracleEbsEncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return {
      oracle_ebs_username: username,
      oracle_ebs_username_enc: null,
      oracle_ebs_password_enc: null,
      oracle_ebs_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    oracle_ebs_username: null,
    oracle_ebs_username_enc: encryptField(username, iv),
    oracle_ebs_password_enc: encryptField(password, iv),
    oracle_ebs_creds_iv: iv,
  };
};

export const oracleEbsIsConfigured = (s) => !!(
  s?.oracle_ebs_base_url && s?.oracle_ebs_username && s?.oracle_ebs_password
);

const basicAuth = (u, p) =>
  "Basic " + Buffer.from(String(u) + ":" + String(p)).toString("base64");

const apiUrl = (s, path, query = {}) => {
  const url = new URL(s.oracle_ebs_base_url.replace(/\/+$/, "") + "/webservices/rest/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const oracleEbsFetch = async (s, { method = "GET", path, body, query } = {}) => {
  if (!oracleEbsIsConfigured(s)) throw new Error("Oracle EBS not configured for this tenant");
  const url = apiUrl(s, path, query);
  const headers = {
    Authorization: basicAuth(s.oracle_ebs_username, s.oracle_ebs_password),
    Accept: "application/json",
  };
  if (s.oracle_ebs_responsibility) headers["RestResponsibility"] = s.oracle_ebs_responsibility;
  if (s.oracle_ebs_org_id) headers["RestOrgId"] = String(s.oracle_ebs_org_id);
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

// Probe: any deployed REST service surfaces a metadata endpoint at
// /webservices/rest/<service>?XSD. We hit a known-stable surface
// (the customer/account list service) for the probe.
export const oracleEbsProbe = async (s) => oracleEbsFetch(s, {
  method: "GET",
  path: "ar_customers/get_customer_list/",
  query: { p_max_rows: "1" },
});

// EBS REST list pattern: services accept p_max_rows + p_start_row
// query parameters (the convention emitted by the Integration
// Repository when generating REST endpoints).
export const oracleEbsList = async (s, path, { extraQuery, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let start = 1;
  while (out.length < maxRows) {
    const query = { p_max_rows: String(top), p_start_row: String(start), ...(extraQuery || {}) };
    const resp = await oracleEbsFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("Oracle EBS list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    // EBS REST wraps result in service-specific keys; we accept the
    // common ones (Items, results, value).
    const items = resp.body?.Items || resp.body?.results || resp.body?.value || [];
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < top) break;
    start += top;
  }
  return out;
};

// Push a Sales Order via OE_ORDER_PUB.Process_Order. The published
// REST service name varies per deployment; we default to the standard
// shape and let `oracle_ebs_field_map.push_path` override.
export const oracleEbsPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    LINE_NUMBER: i + 1,
    INVENTORY_ITEM: ln.itemCode || ln.partNumber || ln.sku,
    ORDERED_QUANTITY: Number(ln.quantity || ln.qty || 1),
    UNIT_SELLING_PRICE: Number(ln.unitPrice || ln.rate || 0),
    ORDER_QUANTITY_UOM: ln.uom || "Ea",
  }));
  const payload = {
    InputParameters: {
      P_HEADER_REC: {
        ORDER_NUMBER: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
        SOLD_TO_ORG_ID: customer.external_ref?.oracle_ebs?.party_id || customer.customer_key || customer.id,
        TRANSACTIONAL_CURR_CODE: result.currency || "USD",
        ORDER_TYPE_ID: fieldMap.order_type_id || 1000,
        ORG_ID: s.oracle_ebs_org_id || fieldMap.org_id || null,
      },
      P_LINE_TBL: lines,
    },
  };
  const path = fieldMap.push_path || "oe_order_pub-1/process_order/";
  const resp = await oracleEbsFetch(s, { method: "POST", path, body: payload });
  // Process_Order returns OutputParameters with X_RETURN_STATUS and
  // X_HEADER_ID. We map the header id as the external id.
  const externalId = resp.body?.OutputParameters?.X_HEADER_ID
    || resp.body?.X_HEADER_ID
    || resp.body?.HEADER_ID
    || null;
  // Failures can return ok=200 with X_RETURN_STATUS != 'S'; treat
  // that as a logical failure.
  const logicalOk = resp.ok && (resp.body?.OutputParameters?.X_RETURN_STATUS || "S") === "S";
  return {
    ok: logicalOk,
    status: resp.status,
    external_id: externalId,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
