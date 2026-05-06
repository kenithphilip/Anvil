// JD Edwards EnterpriseOne (AIS Server) REST client.
//
// Auth: token-pair flow. We POST to /jderest/v3/tokenrequest with
// username + password as JSON body (Basic-auth-style, but JDE wraps
// it in JSON). The response is `{ username, token, ... }` where
// `token` becomes the AIS session token to send as `jde-AIS-Auth-
// Token` header on every subsequent call. Tokens are session-scoped
// in the JAS HTML server; we cache per (tenant, base_url, username)
// with a default 30-min TTL.
//
// Headers `jde-AIS-Auth-Environment`, `jde-AIS-Auth-Role`,
// `jde-AIS-Auth-Device` pin the session to a specific JDE login
// context. They are required for token request and ignored for
// subsequent calls.
//
// Wire shape:
//   <base_url>/jderest/v3/tokenrequest        token mint
//   <base_url>/jderest/v3/dataservice         generic data service
//   <base_url>/jderest/v3/orchestrator/<name> orchestrator runner
// We use orchestrator endpoints for sales-order push (the
// recommended pattern in AIS 9.2.4+). Sync entities use the
// dataservice.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { getOrMintToken, evictToken } from "./token-cache.js";
import { safeFetch } from "./safe-fetch.js";

export const jdeDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.jde_creds_iv) {
      try { return decryptField(s[encCol], s.jde_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.jde_username = tryDec("jde_username_enc", "jde_username");
  out.jde_password = tryDec("jde_password_enc", null);
  return out;
};

export const jdeEncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return {
      jde_username: username,
      jde_username_enc: null,
      jde_password_enc: null,
      jde_creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    jde_username: null,
    jde_username_enc: encryptField(username, iv),
    jde_password_enc: encryptField(password, iv),
    jde_creds_iv: iv,
  };
};

export const jdeIsConfigured = (s) => !!(
  s?.jde_base_url && s?.jde_username && s?.jde_password &&
  s?.jde_environment && s?.jde_role
);

const acquireToken = async (s) => {
  const tokenUrl = s.jde_base_url.replace(/\/+$/, "") + "/jderest/v3/tokenrequest";
  return getOrMintToken({
    tenantId: s.tenant_id || "shared",
    tokenUrl,
    identity: s.jde_username,
    mintFn: async () => {
      const resp = await safeFetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "jde-AIS-Auth-Environment": s.jde_environment,
          "jde-AIS-Auth-Role": s.jde_role || "*ALL",
          "jde-AIS-Auth-Device": s.jde_device || "Anvil",
        },
        body: JSON.stringify({
          username: s.jde_username,
          password: s.jde_password,
          deviceName: s.jde_device || "Anvil",
          environment: s.jde_environment,
          role: s.jde_role || "*ALL",
        }),
      });
      const text = await resp.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_e) { body = { raw: text.slice(0, 400) }; }
      if (!resp.ok || !body?.token) {
        const err = new Error("JDE token request failed: " + resp.status + " " + (body?.message || text.slice(0, 200)));
        err.status = resp.status;
        throw err;
      }
      // JDE sessions follow the rest.ini timeout (default 30 min).
      // Trim to 25 min to stay safely inside the server-side TTL.
      // Audit L6 (May 2026): TTL is configurable per tenant via
      // tenant_settings.jde_session_ttl_sec, defaulting to 1500s.
      // Hardened JDE deployments configure shorter rest.ini
      // timeouts; this lets operators match without code changes.
      const ttlSec = Number(s.jde_session_ttl_sec) || 1500;
      return { token: body.token, expiresInSec: Math.max(60, Math.min(ttlSec, 30 * 60)) };
    },
  });
};

const apiUrl = (s, path, query = {}) => {
  const url = new URL(s.jde_base_url.replace(/\/+$/, "") + "/jderest/v3/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

export const jdeFetch = async (s, { method = "GET", path, body, query, retryOn401 = true } = {}) => {
  if (!jdeIsConfigured(s)) throw new Error("JDE not configured for this tenant");
  const token = await acquireToken(s);
  const url = apiUrl(s, path, query);
  const headers = {
    "jde-AIS-Auth-Token": token,
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
    const tokenUrl = s.jde_base_url.replace(/\/+$/, "") + "/jderest/v3/tokenrequest";
    evictToken(s.tenant_id || "shared", tokenUrl, s.jde_username);
    return jdeFetch(s, { method, path, body, query, retryOn401: false });
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
};

// Probe: hit the token-request endpoint via acquireToken.
export const jdeProbe = async (s) => {
  try {
    await acquireToken(s);
    return { ok: true, status: 200, body: { mint: "ok" } };
  } catch (err) {
    return { ok: false, status: err.status || 0, body: { error: err.message } };
  }
};

// JDE dataservice list: target object (e.g. F0101 Address Book) with
// query criteria. Pagination uses `maxPageSize` + a continuation
// cursor in the response. We loop using the cursor.
export const jdeList = async (s, target, { criteria, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let nextPageId = null;
  while (out.length < maxRows) {
    const body = {
      targetName: target,
      targetType: "table",
      maxPageSize: String(top),
      ...(nextPageId ? { nextPageId } : {}),
      ...(criteria ? { dataServiceType: "BROWSE", query: { autoFind: true, condition: criteria } } : { dataServiceType: "BROWSE" }),
    };
    const resp = await jdeFetch(s, { method: "POST", path: "dataservice", body });
    if (!resp.ok) {
      throw new Error("JDE list " + resp.status + " " + target + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.fs_DATABROWSE_LIST?.data?.gridData?.rowset || [];
    out.push(...items);
    nextPageId = resp.body?.nextPageId || null;
    if (!nextPageId || items.length < top) break;
  }
  return out;
};

// Push a Sales Order via the AIS orchestrator. We use the
// `JDE_ORCH_55_AddSalesOrder` shape as documented in JDE Tools 9.2.5;
// per-tenant `jde_field_map.orchestrator` overrides the orchestrator
// name when a customer has a custom one.
export const jdePushSalesOrder = async (s, anvilOrder, fieldMap = {}) => {
  const customer = anvilOrder.customer || {};
  const result = anvilOrder.result?.salesOrder || {};
  const orch = fieldMap.orchestrator || "JDE_ORCH_55_AddSalesOrder";
  const lines = (result.lineItems || []).map((ln, i) => ({
    LineNumber: i + 1,
    ItemNumber: ln.itemCode || ln.partNumber || ln.sku,
    Quantity: Number(ln.quantity || ln.qty || 1),
    UnitPrice: Number(ln.unitPrice || ln.rate || 0),
    UnitOfMeasure: ln.uom || "EA",
  }));
  const payload = {
    inputs: [
      { name: "CustomerNumber", value: customer.external_ref?.jde?.address_number || customer.customer_key || customer.id },
      { name: "OrderType", value: fieldMap.order_type || "SO" },
      { name: "BranchPlant", value: fieldMap.branch_plant || "M30" },
      { name: "Currency", value: result.currency || "USD" },
      { name: "OrderReference", value: anvilOrder.po_number || anvilOrder.quote_number || anvilOrder.id?.slice(0, 12) },
      { name: "Lines", value: JSON.stringify(lines) },
    ],
  };
  const resp = await jdeFetch(s, { method: "POST", path: "orchestrator/" + orch, body: payload });
  // Orchestrator output schemas vary; pull commonly-named keys.
  const externalId = resp.body?.OrderNumber
    || resp.body?.ServiceRequest1?.fs_DATABROWSE_F4201?.data?.gridData?.rowset?.[0]?.SDDOCO
    || resp.body?.id
    || null;
  return {
    ok: resp.ok,
    status: resp.status,
    external_id: externalId,
    response: resp.body,
    latency_ms: resp.latency_ms,
  };
};
