// JobBoss² (ECi Solutions) REST client.
//
// Auth: bearer token issued via the ECi customer portal. Tokens are
// long-lived but rotatable; callers store them encrypted at rest
// (jobboss_token_enc) and rotate via the connect endpoint.
//
// Wire shape:
//   <base_url>/api/v1/<resource>
// Companies surface separately under /api/v1/companies; many calls
// require an `X-JobBoss-Company` header pinning the request to a
// specific multi-company tenant.
//
// SFTP fallback: where REST is not enabled (older on-prem deployments)
// the same migration provides jobboss_sftp_* fields; callers can
// implement a flat-file drop adapter against those, but it's out of
// scope for v1. The REST path is the supported surface here.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

export const jobbossDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol) => {
    if (s[encCol] && s.jobboss_creds_iv) {
      try { return decryptField(s[encCol], s.jobboss_creds_iv); }
      catch (_e) { return null; }
    }
    return null;
  };
  out.jobboss_token = tryDec("jobboss_token_enc");
  return out;
};

export const jobbossEncryptCreds = ({ token }) => {
  if (!isSecretsConfigured()) {
    return {
      jobboss_token_enc: null,
      jobboss_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    jobboss_token_enc: encryptField(token, iv),
    jobboss_creds_iv: iv,
  };
};

export const jobbossIsConfigured = (s) => !!(
  s?.jobboss_base_url && s?.jobboss_token
);

const apiUrl = (s, path, query = {}) => {
  const url = new URL(s.jobboss_base_url.replace(/\/+$/, "") + "/api/v1/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const jobbossFetch = async (s, { method = "GET", path, body, query } = {}) => {
  if (!jobbossIsConfigured(s)) throw new Error("JobBoss not configured for this tenant");
  const url = apiUrl(s, path, query);
  const headers = {
    Authorization: "Bearer " + s.jobboss_token,
    Accept: "application/json",
  };
  if (s.jobboss_company) headers["X-JobBoss-Company"] = s.jobboss_company;
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

export const jobbossProbe = async (s) => jobbossFetch(s, {
  method: "GET", path: "customers", query: { limit: 1 },
});

export const jobbossList = async (s, path, { filter, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let offset = 0;
  while (out.length < maxRows) {
    const query = { limit: String(top), offset: String(offset) };
    if (filter) query.filter = filter;
    const resp = await jobbossFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("JobBoss list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.data || resp.body?.results || resp.body?.value || [];
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < top) break;
    offset += top;
  }
  return out;
};

// JobBoss is a job-shop ERP, so "sales orders" are typically
// "quotes" or "jobs" depending on the workflow. We push to the
// quotes resource and let the operator promote to a job inside
// JobBoss; per-tenant fieldMap.resource overrides if the tenant
// wants direct job creation.
export const jobbossPushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const lines = (result.lineItems || []).map((ln, i) => ({
    lineNumber: i + 1,
    partNumber: ln.itemCode || ln.partNumber || ln.sku,
    quantity: Number(ln.quantity || ln.qty || 1),
    unitPrice: Number(ln.unitPrice || ln.rate || 0),
    unitOfMeasure: ln.uom || "Each",
  }));
  const payload = {
    quoteNumber: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12),
    customerId: customer.external_ref?.jobboss?.customer_id || customer.customer_key || customer.id,
    quoteDate: new Date().toISOString().slice(0, 10),
    currency: result.currency || "USD",
    lines,
  };
  const resp = await jobbossFetch(s, {
    method: "POST",
    path: fieldMap.resource || "quotes",
    body: payload,
  });
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: resp.body?.quoteNumber || resp.body?.jobNumber || resp.body?.id || null,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
