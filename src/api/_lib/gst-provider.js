// GST registry lookup provider (issue #186, P1).
//
// The STRUCTURAL half of a GSTIN — state code, PAN, format + checksum validity
// — is derivable with NO API call (see _lib/gstin.js), and the endpoint always
// returns it. This module is the pluggable REGISTRY half: the taxpayer's legal
// / trade name, principal address, and status come from a GST provider (GSTN
// itself needs a GSP licence, so tenants wire a wrapper — Sandbox / Masters
// India / Surepass / etc.).
//
// DEFAULT-DENY: with no provider configured we return { ok:false,
// reason:'not_configured' } and the caller falls back to manual name/address
// entry. A concrete provider is a thin `fetch` + `normalizeRegistry` mapping.
//
// normalizeRegistry() is pure + exported so a provider integration + its tests
// map raw responses to our shape without re-deriving it.

import { decryptField } from "./secrets.js";

// Read the tenant's GST provider config. creds are encrypted with the shared
// docai_creds_iv (same envelope as the other provider keys).
const providerConfig = (settings) => {
  const provider = String(settings?.gst_provider || "none").toLowerCase();
  if (provider === "none" || !provider) return { provider: "none" };
  let apiKey = null;
  if (settings?.gst_provider_api_key_enc && settings?.docai_creds_iv) {
    try { apiKey = decryptField(settings.gst_provider_api_key_enc, settings.docai_creds_iv); } catch (_e) { apiKey = null; }
  }
  apiKey = apiKey || process.env.GST_PROVIDER_API_KEY || null;
  const baseUrl = settings?.gst_provider_url || process.env.GST_PROVIDER_URL || null;
  return { provider, apiKey, baseUrl };
};

// Map a provider's raw payload to the normalized registry shape. Providers use
// different field names; a per-provider mapping funnels into this. The generic
// mapping covers the common `{ legal_name/lgnm, trade_name/tradeNam, ... }`
// shapes seen across Indian GST wrappers.
export const normalizeRegistry = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...keys) => { for (const k of keys) { const v = raw[k]; if (v != null && v !== "") return v; } return null; };
  const addr = pick("principal_address", "pradr", "address", "addr");
  const addrText = typeof addr === "string" ? addr : (addr && (addr.adr || addr.address)) || null;
  return {
    legal_name: pick("legal_name", "lgnm", "legalName"),
    trade_name: pick("trade_name", "tradeNam", "tradeName", "tradenam"),
    address: addrText,
    status: pick("status", "sts", "gstin_status"),
    taxpayer_type: pick("taxpayer_type", "dty", "type"),
    registration_date: pick("registration_date", "rgdt", "regDate"),
  };
};

// Look up the registry half for a (validated, upper-cased) GSTIN. Returns
// { ok:true, source:'provider', data } | { ok:false, reason }.
export const lookupGstinRegistry = async (gstin, settings) => {
  const cfg = providerConfig(settings);
  if (cfg.provider === "none") return { ok: false, reason: "not_configured" };
  if (!cfg.apiKey || !cfg.baseUrl) return { ok: false, reason: "not_configured" };
  // A concrete provider fetch slots in here (POST the GSTIN with the key, then
  // `normalizeRegistry(await resp.json())`). Until a provider is wired we treat
  // an unknown provider as not-configured rather than guess its wire format.
  return { ok: false, reason: "provider_unimplemented", provider: cfg.provider };
};
