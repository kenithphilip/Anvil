// M1xchange TReDS client.
//
// M1xchange is the highest-throughput TReDS platform in 2026
// (Rs 1 lakh cr in 10 months FY26). They expose an API for
// channel partners + TSPs to submit invoices on behalf of MSME
// suppliers. The surface we use:
//
//   POST /v1/factoring                       - submit an invoice
//   GET  /v1/factoring/{id}                  - poll auction state
//   POST /v1/factoring/{id}/accept           - accept the best bid
//   GET  /v1/buyers?gstin=...                - eligible-buyer cache
//   POST /v1/factoring/{id}/withdraw         - cancel before bid
//
// Production activation requires the M1xchange channel-partner
// agreement + member_id + api_key + api_secret. Until then,
// SANDBOX MODE returns canned auctions that walk through the
// realistic state machine (submitted -> live -> won) so the
// operator UI and the polling cron can be exercised end-to-end.

import crypto from "node:crypto";
import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const PROD_BASE_URL = "https://api-uat.m1xchange.com";  // UAT URL; prod swaps to api.m1xchange.com
const SANDBOX_PROVIDERS = new Set(["sandbox", "none", null, undefined]);

const decryptCreds = (s) => {
  if (!s) return { member_id: null, api_key: null, api_secret: null };
  if (s.treds_api_key_enc && s.treds_creds_iv) {
    try {
      return {
        member_id: s.treds_member_id || null,
        api_key: decryptField(s.treds_api_key_enc, s.treds_creds_iv),
        api_secret: decryptField(s.treds_api_secret_enc, s.treds_creds_iv),
      };
    } catch (_e) { /* fall through */ }
  }
  return {
    member_id: s.treds_member_id || null,
    api_key: s.treds_api_key || null,
    api_secret: s.treds_api_secret || null,
  };
};

export const m1xchangeIsConfigured = (s) => {
  if (!s) return false;
  if (SANDBOX_PROVIDERS.has(s.treds_provider)) return false;
  const { member_id, api_key } = decryptCreds(s);
  return !!(member_id && api_key);
};

export const m1xchangeMode = (s) => {
  if (m1xchangeIsConfigured(s)) return "prod";
  return "sandbox";
};

// Deterministic mock external_factoring_id so polling is
// reproducible across processes.
const sandboxFactoringId = ({ tenantId, invoiceId }) =>
  "sbxf_" + crypto.createHash("sha256")
    .update([tenantId, invoiceId].join("|"))
    .digest("hex").slice(0, 20);

// Sandbox state machine. Driver: the offer was created at `start`,
// and we move forward in time:
//
//   t = 0          submitted
//   t > 2 min      live
//   t > 5 min      won, with a fixed mock bid
//
// Tests can pass an explicit `nowMs` to inspect specific states.
const sandboxAuctionState = ({ start, nowMs, amountInr }) => {
  const elapsedSec = Math.max(0, ((nowMs || Date.now()) - start) / 1000);
  let status = "submitted";
  if (elapsedSec > 300) status = "won";
  else if (elapsedSec > 120) status = "live";
  const rateBps = 1140;  // 11.40% p.a.
  const tenureDays = 60;
  const discount = Number(amountInr) * (rateBps / 10000) * (tenureDays / 365);
  const fee = Number(amountInr) * 0.0015;  // 15 bps platform fee
  return {
    status,
    best_rate_bps: status === "won" ? rateBps : null,
    best_financier_name: status === "won" ? "Sandbox Financier A (NBFC)" : null,
    discount_inr: status === "won" ? Number(discount.toFixed(2)) : null,
    fee_inr: status === "won" ? Number(fee.toFixed(2)) : null,
    net_amount_inr: status === "won" ? Number((Number(amountInr) - discount).toFixed(2)) : null,
    is_sandbox: true,
  };
};

// Submit an invoice for factoring. Returns the platform's
// external_factoring_id and the initial auction_status.
//
// Inputs (canonical shape per the plan doc):
//   tenantId, invoiceId               for sandbox keying
//   invoiceNumber, irn, buyerGstin
//   amountInr, dueDate
//   supplierBankAccount               IFSC / account no for disbursement
export const submitFactoring = async (settings, input) => {
  if (m1xchangeMode(settings) === "sandbox") {
    const id = sandboxFactoringId(input);
    return {
      external_factoring_id: id,
      auction_status: "submitted",
      created_at: new Date().toISOString(),
      is_sandbox: true,
    };
  }
  const { member_id, api_key, api_secret } = decryptCreds(settings);
  const auth = "Basic " + Buffer.from(api_key + ":" + api_secret).toString("base64");
  const body = {
    memberId: member_id,
    invoiceNumber: input.invoiceNumber,
    irn: input.irn || null,
    buyerGstin: input.buyerGstin,
    amount: input.amountInr,
    dueDate: input.dueDate,
    supplierBankAccount: input.supplierBankAccount,
  };
  const resp = await safeFetch(PROD_BASE_URL + "/v1/factoring", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("m1xchange/submit: " + (resp.error || resp.statusText));
  return {
    external_factoring_id: resp.data?.factoringId || resp.data?.id,
    auction_status: (resp.data?.status || "submitted").toLowerCase(),
    created_at: resp.data?.createdAt || new Date().toISOString(),
    is_sandbox: false,
  };
};

// Poll the auction status. Sandbox advances based on wall-clock
// since the offer was created (passed in `start`).
export const getAuctionStatus = async (settings, externalFactoringId, { start = Date.now(), nowMs, amountInr } = {}) => {
  if (m1xchangeMode(settings) === "sandbox" || (externalFactoringId || "").startsWith("sbxf_")) {
    return sandboxAuctionState({ start, nowMs, amountInr });
  }
  const { api_key, api_secret } = decryptCreds(settings);
  const auth = "Basic " + Buffer.from(api_key + ":" + api_secret).toString("base64");
  const resp = await safeFetch(
    PROD_BASE_URL + "/v1/factoring/" + encodeURIComponent(externalFactoringId),
    { method: "GET", headers: { Authorization: auth } },
  );
  if (!resp.ok) throw new Error("m1xchange/poll: " + (resp.error || resp.statusText));
  const j = resp.data || {};
  return {
    status: (j.status || "submitted").toLowerCase(),
    best_rate_bps: j.bestRateBps || null,
    best_financier_name: j.bestFinancier || null,
    discount_inr: j.discount || null,
    fee_inr: j.fee || null,
    net_amount_inr: j.netAmount || null,
    is_sandbox: false,
  };
};

// Accept the best bid. Disbursement settles T+1 to the supplier
// bank account. Returns the financier + UTR (sandbox returns a
// mock UTR).
export const acceptBestBid = async (settings, externalFactoringId, { amountInr } = {}) => {
  if (m1xchangeMode(settings) === "sandbox" || (externalFactoringId || "").startsWith("sbxf_")) {
    const auction = sandboxAuctionState({ start: 0, amountInr });    // forces state = won
    return {
      financier_name: auction.best_financier_name,
      rate_bps: auction.best_rate_bps,
      net_to_supplier_inr: auction.net_amount_inr,
      platform_fee_inr: auction.fee_inr,
      settlement_at: new Date(Date.now() + 86400_000).toISOString(),
      utr: "SBX" + crypto.randomBytes(6).toString("hex").toUpperCase(),
      status: "disbursed",
      is_sandbox: true,
    };
  }
  const { api_key, api_secret } = decryptCreds(settings);
  const auth = "Basic " + Buffer.from(api_key + ":" + api_secret).toString("base64");
  const resp = await safeFetch(
    PROD_BASE_URL + "/v1/factoring/" + encodeURIComponent(externalFactoringId) + "/accept",
    { method: "POST", headers: { Authorization: auth } },
  );
  if (!resp.ok) throw new Error("m1xchange/accept: " + (resp.error || resp.statusText));
  return resp.data || {};
};

// Withdraw (cancel) an offer before the buyer accepts it.
// Sandbox returns ok immediately.
export const withdrawOffer = async (settings, externalFactoringId) => {
  if (m1xchangeMode(settings) === "sandbox" || (externalFactoringId || "").startsWith("sbxf_")) {
    return { status: "withdrawn", is_sandbox: true };
  }
  const { api_key, api_secret } = decryptCreds(settings);
  const auth = "Basic " + Buffer.from(api_key + ":" + api_secret).toString("base64");
  const resp = await safeFetch(
    PROD_BASE_URL + "/v1/factoring/" + encodeURIComponent(externalFactoringId) + "/withdraw",
    { method: "POST", headers: { Authorization: auth } },
  );
  if (!resp.ok) throw new Error("m1xchange/withdraw: " + (resp.error || resp.statusText));
  return resp.data || {};
};

// Eligible-buyer GSTIN feed. Real M1xchange exposes this as
// /v1/buyers; sandbox returns a tiny canned set so the UI can
// gate the "Discount via TReDS" button on whether the buyer is
// already TReDS-onboarded.
export const getEligibleBuyers = async (settings) => {
  if (m1xchangeMode(settings) === "sandbox") {
    return [
      { gstin: "27AAACR5055K1Z5",  name: "Sandbox Buyer Alpha Pvt Ltd", active: true },
      { gstin: "27AAFCS0014D1Z6",  name: "Sandbox Buyer Beta Industries", active: true },
      { gstin: "33AAACS3856L1Z9",  name: "Sandbox Buyer Gamma Auto", active: true },
    ];
  }
  const { api_key, api_secret } = decryptCreds(settings);
  const auth = "Basic " + Buffer.from(api_key + ":" + api_secret).toString("base64");
  const resp = await safeFetch(PROD_BASE_URL + "/v1/buyers", {
    method: "GET",
    headers: { Authorization: auth },
  });
  if (!resp.ok) throw new Error("m1xchange/buyers: " + (resp.error || resp.statusText));
  const j = resp.data || {};
  return (j.buyers || []).map((b) => ({
    gstin: b.gstin,
    name: b.name,
    active: !!b.active,
  }));
};

export const __test = {
  sandboxFactoringId, sandboxAuctionState, SANDBOX_PROVIDERS,
};
