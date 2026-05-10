// Setu Account Aggregator client.
//
// Setu's AA Gateway exposes a single FIU API surface across the
// active NBFC-AA set (Anumati, CAMS Finserv, OneMoney, Finvu,
// NADL, Setu's own AA). The endpoints we care about:
//
//   POST /v2/consents              - request a new consent
//   GET  /v2/consents/{handle}     - poll consent state
//   POST /v2/sessions              - request a data fetch
//   GET  /v2/sessions/{id}         - poll fetch state
//
// Production activation requires:
//   - Setu FIU partner ID + client_id + client_secret (encrypted
//     on tenant_settings via aa_client_*_enc / aa_creds_iv)
//   - Sahamati certification of the FIU we integrate under
//   - DPDP consent text in the embed UI
//
// SANDBOX MODE: when tenant_settings.aa_provider = 'sandbox' OR
// the credentials are absent, every method returns deterministic
// canned responses suitable for the operator UI, the cron poller,
// and the test harness. Sandbox responses are stable per
// consent_handle so the polling state machine can be exercised.

import crypto from "node:crypto";
import { decryptField, isSecretsConfigured } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const PROD_BASE_URL = "https://fiu-uat.setu.co";   // Setu UAT URL; prod swaps to fiu.setu.co
const SANDBOX_PROVIDERS = new Set(["sandbox", "none", null, undefined]);

const decryptCreds = (s) => {
  if (!s) return { client_id: null, client_secret: null };
  if (s.aa_client_id_enc && s.aa_creds_iv) {
    try {
      return {
        client_id: decryptField(s.aa_client_id_enc, s.aa_creds_iv),
        client_secret: decryptField(s.aa_client_secret_enc, s.aa_creds_iv),
      };
    } catch (_e) { /* fall through */ }
  }
  return {
    client_id: s.aa_client_id || null,
    client_secret: s.aa_client_secret || null,
  };
};

// Sandbox mode is the default unless aa_provider is set to a real
// gateway AND we have decryptable credentials.
export const setuIsConfigured = (s) => {
  if (!s) return false;
  if (SANDBOX_PROVIDERS.has(s.aa_provider)) return false;
  const { client_id, client_secret } = decryptCreds(s);
  return !!(client_id && client_secret);
};

export const setuMode = (s) => {
  if (setuIsConfigured(s)) return "prod";
  return "sandbox";
};

// Deterministic sandbox-mode consent_handle so polling is
// reproducible.  Same input -> same handle, with the prefix
// "sbx_" so it's visually obvious in DB rows and audit logs.
const sandboxHandle = ({ tenantId, invoiceId, purpose }) =>
  "sbx_" + crypto.createHash("sha256")
    .update([tenantId, invoiceId, purpose, "consent"].join("|"))
    .digest("hex").slice(0, 24);

const sandboxConsentResponse = (input) => ({
  consent_handle: sandboxHandle(input),
  consent_id: null,
  status: "PENDING",
  redirect_url: "https://anvil.local/api/aa/callback?sandbox=1&handle=" + sandboxHandle(input),
  expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  is_sandbox: true,
});

const sandboxPollResponse = (handle) => ({
  consent_handle: handle,
  consent_id: handle.replace("sbx_", "sbxid_"),
  status: "ACTIVE",
  granted_at: new Date().toISOString(),
  fi_types: ["DEPOSIT"],
  is_sandbox: true,
});

const sandboxFetchResponse = (handle) => ({
  consent_handle: handle,
  session_id: handle.replace("sbx_", "sbxs_"),
  status: "COMPLETED",
  is_sandbox: true,
  summary: {
    // A short, opinionated mock of what the financier sees so the
    // UI can render an "AA returned: 6 months of statements,
    // average balance Rs 8.2 lakh" block during testing.
    account_kind: "savings",
    months: 6,
    average_balance_inr: 820_000,
    total_inflows_inr: 12_400_000,
    total_outflows_inr: 11_900_000,
  },
});

// POST a new consent request. Returns the consent_handle the UI
// renders in the Setu Embed iframe + the upstream status.
//
// Inputs:
//   tenantId, invoiceId          identifiers for sandbox keying
//   purpose                       short string (e.g. "working_capital_treds")
//   fiTypes                       AA data-types requested (defaults to deposit accounts)
//   redirectUrl                   prod-only; sandbox uses our local callback
//
// Output (sandbox + prod): { consent_handle, redirect_url, status,
// expires_at, is_sandbox }.
export const requestConsent = async (settings, input) => {
  if (setuMode(settings) === "sandbox") return sandboxConsentResponse(input);
  const { client_id, client_secret } = decryptCreds(settings);
  const body = {
    purposeCode: input.purpose || "working_capital_treds",
    fiTypes: input.fiTypes || ["DEPOSIT"],
    redirectUrl: input.redirectUrl,
    fipId: settings.aa_fiu_partner_id || null,
  };
  const resp = await safeFetch(PROD_BASE_URL + "/v2/consents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": client_id,
      "x-client-secret": client_secret,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("setu/consent: " + (resp.error || resp.statusText));
  const j = resp.data || {};
  return {
    consent_handle: j.consentHandle || j.consent_handle,
    consent_id: j.consentId || null,
    status: j.status || "PENDING",
    redirect_url: j.redirectUrl || j.redirect_url,
    expires_at: j.expiresAt || null,
    is_sandbox: false,
  };
};

// Poll a consent's state. In sandbox mode this flips
// PENDING -> ACTIVE on first call so the cron can move forward.
export const pollConsent = async (settings, consentHandle) => {
  if (setuMode(settings) === "sandbox" || (consentHandle || "").startsWith("sbx_")) {
    return sandboxPollResponse(consentHandle);
  }
  const { client_id, client_secret } = decryptCreds(settings);
  const resp = await safeFetch(PROD_BASE_URL + "/v2/consents/" + encodeURIComponent(consentHandle), {
    method: "GET",
    headers: { "x-client-id": client_id, "x-client-secret": client_secret },
  });
  if (!resp.ok) throw new Error("setu/poll: " + (resp.error || resp.statusText));
  return resp.data || {};
};

// Request the financial-data fetch. Sandbox returns a canned
// 6-month bank-statement summary so the UI can render its
// "data ready" state.
export const fetchData = async (settings, consentHandle) => {
  if (setuMode(settings) === "sandbox" || (consentHandle || "").startsWith("sbx_")) {
    return sandboxFetchResponse(consentHandle);
  }
  const { client_id, client_secret } = decryptCreds(settings);
  const resp = await safeFetch(PROD_BASE_URL + "/v2/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": client_id,
      "x-client-secret": client_secret,
    },
    body: JSON.stringify({ consentHandle }),
  });
  if (!resp.ok) throw new Error("setu/session: " + (resp.error || resp.statusText));
  return resp.data || {};
};

// HMAC-SHA256 webhook verification. Setu signs each webhook with
// the FIU's webhook_secret over the raw body; the header
// `x-setu-signature` carries the hex digest. Sandbox accepts
// without verifying (no secret available).
export const verifyWebhook = ({ settings, rawBody, signature }) => {
  if (setuMode(settings) === "sandbox") return { ok: true, sandbox: true };
  const secret = settings.aa_client_secret || null;
  if (!secret) return { ok: false, error: "no_webhook_secret" };
  if (!signature) return { ok: false, error: "no_signature" };
  const expected = crypto.createHmac("sha256", secret)
    .update(rawBody || "")
    .digest("hex");
  // timingSafeEqual throws on length mismatch; pad-check first.
  if (expected.length !== signature.length) return { ok: false, error: "length_mismatch" };
  const ok = crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature),
  );
  return { ok };
};

void isSecretsConfigured; // intentional reference; secrets used via decryptField

export const __test = {
  sandboxHandle, sandboxConsentResponse, sandboxPollResponse,
  sandboxFetchResponse, SANDBOX_PROVIDERS,
};
