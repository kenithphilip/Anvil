// Tally bridge HTTP client.
//
// The Anvil server doesn't talk to Tally directly. Each tenant runs
// a small HTTP bridge on the same machine as Tally Prime; that
// bridge accepts XML over POST and forwards it to Tally's TCP-based
// XML interface (the `:9000` port). The bridge contract is:
//
//   POST <bridge_url>          XML envelope, returns Tally's XML
//                              response. Used for Sales Order push,
//                              receipts, master ops.
//
//   GET  <bridge_url>/health   { ok, version, company } JSON. Used
//                              by /api/tally/diagnostics.
//
//   POST <bridge_url>/sync     { since: ISO } -> { vouchers: [...] }
//                              Reverse pull of vouchers altered or
//                              created since `since`. Bridge v2.
//
//   POST <bridge_url>/payments { since: ISO } -> { receipts: [...] }
//                              Receipt vouchers since `since`.
//                              Bridge v2.
//
//   POST <bridge_url>/amend    XML envelope; same as the root push
//                              but tagged so the bridge applies an
//                              alter rather than create.
//
// All endpoints accept Authorization: Bearer <bridge_token>.
// The bridge token + URL live on tally_companies; we decrypt the
// token at use time.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

export const tallyDecryptToken = (company) => {
  if (!company) return null;
  if (company.bridge_token_enc && company.bridge_iv) {
    try { return decryptField(company.bridge_token_enc, company.bridge_iv); }
    catch (_e) { return company.bridge_token || null; }
  }
  return company.bridge_token || null;
};

export const tallyEncryptedTokenColumns = (token) => {
  if (!token) return { bridge_token: null, bridge_token_enc: null, bridge_iv: null };
  if (!isSecretsConfigured()) return { bridge_token: token, bridge_token_enc: null, bridge_iv: null };
  const iv = newIv();
  return { bridge_token: null, bridge_token_enc: encryptField(token, iv), bridge_iv: iv };
};

const headers = (company) => {
  const t = tallyDecryptToken(company);
  const out = { "Content-Type": "text/xml" };
  if (t) out.Authorization = "Bearer " + t;
  return out;
};

const jsonHeaders = (company) => {
  const t = tallyDecryptToken(company);
  const out = { "Content-Type": "application/json", Accept: "application/json" };
  if (t) out.Authorization = "Bearer " + t;
  return out;
};

const ensureUrl = (company, suffix = "") => {
  if (!company?.bridge_url) {
    throw Object.assign(new Error("Tally bridge URL not configured for this company"), { status: 409 });
  }
  const base = company.bridge_url.replace(/\/+$/, "");
  return suffix ? base + suffix : base;
};

export const tallyPush = async (company, xml, opts) => {
  const url = ensureUrl(company);
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(company),
    body: xml,
    signal: opts?.signal,
  });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    body: text,
    latency_ms: Date.now() - t0,
  };
};

export const tallyAmend = async (company, xml) => {
  const url = ensureUrl(company, "/amend");
  const t0 = Date.now();
  const resp = await fetch(url, { method: "POST", headers: headers(company), body: xml });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, body: text, latency_ms: Date.now() - t0 };
};

export const tallyHealth = async (company) => {
  const url = ensureUrl(company, "/health");
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { method: "GET", headers: jsonHeaders(company) });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
    return { ok: resp.ok, status: resp.status, body: parsed, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, body: { error: err.message }, latency_ms: Date.now() - t0 };
  }
};

export const tallySyncVouchers = async (company, since) => {
  const url = ensureUrl(company, "/sync");
  const resp = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(company),
    body: JSON.stringify({ since: since || null }),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 800) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

export const tallySyncPayments = async (company, since) => {
  const url = ensureUrl(company, "/payments");
  const resp = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(company),
    body: JSON.stringify({ since: since || null }),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 800) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

export const tallyIsRecoverable = (status) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

// Default-company resolver. Falls back to env-configured single bridge
// when no tally_companies row is set, so v1 deployments keep working
// without a migration step.
export const tallyResolveCompany = async (svc, tenantId, companyId) => {
  if (companyId) {
    const r = await svc.from("tally_companies").select("*").eq("tenant_id", tenantId).eq("id", companyId).maybeSingle();
    if (r.data) return r.data;
  }
  const def = await svc.from("tally_companies").select("*").eq("tenant_id", tenantId).eq("is_default", true).maybeSingle();
  if (def.data) return def.data;
  // Single-row fallback: pick the first company for this tenant.
  const any = await svc.from("tally_companies").select("*").eq("tenant_id", tenantId).order("created_at").limit(1).maybeSingle();
  if (any.data) return any.data;
  // Env-configured legacy single bridge.
  if (process.env.TALLY_BRIDGE_URL) {
    return {
      id: null,
      tenant_id: tenantId,
      name: "default",
      is_default: true,
      bridge_url: process.env.TALLY_BRIDGE_URL,
      bridge_token: process.env.TALLY_BRIDGE_TOKEN || null,
    };
  }
  return null;
};
