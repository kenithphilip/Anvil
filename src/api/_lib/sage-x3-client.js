// Sage X3 (Sage Enterprise Management) REST client.
//
// Auth: OAuth2 client_credentials. Token endpoint and client_id /
// client_secret come from per-tenant `sagex3_settings`.
//
// Endpoint shape: /sdata/<solution>/<entity>?representation=<entity>.$query
// Sage X3 uses the SData protocol over HTTP, which looks JSON-like
// but is actually Atom-with-JSON-payloads in places. We always
// request JSON ($format=json) and let SData wrap it.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { oauth2ClientCredentials, oauth2Evict } from "./oauth2.js";

export const sagex3DecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.sagex3_creds_iv) {
      try { return decryptField(s[encCol], s.sagex3_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.sagex3_client_id = tryDec("sagex3_client_id_enc", "sagex3_client_id");
  out.sagex3_client_secret = tryDec("sagex3_client_secret_enc", null);
  return out;
};

export const sagex3EncryptCreds = ({ client_id, client_secret }) => {
  if (!isSecretsConfigured()) {
    return {
      sagex3_client_id: client_id,
      sagex3_client_id_enc: null,
      sagex3_client_secret_enc: null,
      sagex3_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    sagex3_client_id: null,
    sagex3_client_id_enc: encryptField(client_id, iv),
    sagex3_client_secret_enc: encryptField(client_secret, iv),
    sagex3_creds_iv: iv,
  };
};

export const sagex3IsConfigured = (s) => !!(
  s?.sagex3_base_url && s?.sagex3_token_url && s?.sagex3_client_id && s?.sagex3_client_secret
);

const acquireToken = async (s) => oauth2ClientCredentials({
  tenantId: s.tenant_id || "shared",
  tokenUrl: s.sagex3_token_url,
  clientId: s.sagex3_client_id,
  clientSecret: s.sagex3_client_secret,
  scope: "openid",                                 // Sage X3's standard scope
});

// Compose the SData URL for a given entity. Solution defaults to
// "X3"; representation includes the company / locale so X3 routes
// correctly. The entity path follows "/sdata/<solution>/<endpoint>"
// where endpoint is one of x3/erp/<folder>/CUSTOMER, ITEM, SOH, etc.
const sdataUrl = (s, entity, query = {}) => {
  const sol = s.sagex3_solution || "X3";
  const folder = s.sagex3_company || "SEED";
  const pathParts = ["/sdata", sol, "x3", "erp", folder, entity];
  const url = new URL(s.sagex3_base_url.replace(/\/+$/, "") + pathParts.join("/"));
  url.searchParams.set("$format", "json");
  if (s.sagex3_locale) url.searchParams.set("$locale", s.sagex3_locale);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const sagex3Fetch = async (s, { method = "GET", entity, body, query, retryOn401 = true } = {}) => {
  if (!sagex3IsConfigured(s)) throw new Error("Sage X3 not configured for this tenant");
  const token = await acquireToken(s);
  const url = sdataUrl(s, entity, query);
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401 && retryOn401) {
    oauth2Evict(s.tenant_id || "shared", s.sagex3_token_url, s.sagex3_client_id);
    return sagex3Fetch(s, { method, entity, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

// Probe: cheapest possible authenticated call. List a single
// customer record using $top=1.
export const sagex3Probe = async (s) => sagex3Fetch(s, {
  method: "GET",
  entity: "CUSTOMER",
  query: { $top: 1 },
});

// Cursor-based list with $top + $skip. Sage X3 OData-style filter
// syntax is supported via $filter.
export const sagex3List = async (s, entity, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (filter) query.$filter = filter;
    const resp = await sagex3Fetch(s, { method: "GET", entity, query });
    if (!resp.ok) {
      throw new Error("Sage X3 list " + resp.status + " " + entity + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.$resources || resp.body?.value || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};

// Push a Sales Order. Sage X3's SOH (Sales Order Header) representation
// is documented; required fields are SOHTYP (order type), SALFCY
// (sales site), BPCORD (sold-to customer code), CUR (currency),
// and a SOL (lines) collection.
export const sagex3PushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    SOPLIN: i + 1,
    ITMREF: ln.itemCode || ln.partNumber || ln.sku,
    QTY: Number(ln.quantity || ln.qty || 1),
    GROPRI: Number(ln.unitPrice || ln.rate || 0),
    UOM: ln.uom || "EA",
  }));
  const payload = {
    SOHTYP: fieldMap.order_type || "SON",            // standard order
    SALFCY: fieldMap.sales_site || "MAIN",
    BPCORD: customer.external_ref?.sage_x3?.bpc_code || customer.customer_key || customer.id,
    CUR: result.currency || "USD",
    REF: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    SOL: lines,
  };
  const resp = await sagex3Fetch(s, { method: "POST", entity: "SOH", body: payload });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.SOHNUM || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
