// Bet 6 regression tests: AA + TReDS sandbox scaffolding.
//
// Covers:
//   1. Setu client sandbox-mode determinism (consent_handle is
//      stable across invocations with the same input).
//   2. Setu client webhook HMAC verification (sandbox accepts;
//      prod requires correct signature).
//   3. M1xchange client sandbox-state machine: submitted -> live
//      after 2 min -> won after 5 min of wall-clock time.
//   4. M1xchange acceptBestBid emits a sandbox UTR prefix.
//   5. M1xchange getEligibleBuyers returns a canned 3-row set in
//      sandbox mode.
//   6. Source-contract regression: migration columns + CHECK
//      constraints, router wiring, client surface, nav + rbac +
//      routes entries.
//
// Sandbox flows are explicitly hermetic: no DB, no network. The
// tests confirm the mock state machines so the operator UI can
// rely on deterministic behaviour while partner onboarding is in
// progress.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  setuIsConfigured, setuMode, requestConsent, pollConsent,
  fetchData, verifyWebhook, __test as setuTest,
} from "../api/_lib/aa/setu-client.js";
import {
  m1xchangeIsConfigured, m1xchangeMode,
  submitFactoring, getAuctionStatus, acceptBestBid,
  withdrawOffer, getEligibleBuyers, __test as m1Test,
} from "../api/_lib/treds/m1xchange-client.js";

const SRC = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// -------------------- Setu sandbox ------------------------------

describe("Bet 6 - Setu client sandbox mode", () => {
  it("setuIsConfigured returns false when aa_provider is sandbox / none / null", () => {
    expect(setuIsConfigured(null)).toBe(false);
    expect(setuIsConfigured({})).toBe(false);
    expect(setuIsConfigured({ aa_provider: "sandbox" })).toBe(false);
    expect(setuIsConfigured({ aa_provider: "none" })).toBe(false);
  });

  it("setuIsConfigured returns false when provider is set but creds missing", () => {
    expect(setuIsConfigured({ aa_provider: "setu" })).toBe(false);
  });

  it("setuMode reports sandbox by default", () => {
    expect(setuMode({})).toBe("sandbox");
    expect(setuMode({ aa_provider: "sandbox" })).toBe("sandbox");
  });

  it("requestConsent returns a deterministic sandbox handle", async () => {
    const a = await requestConsent({}, { tenantId: "t1", invoiceId: "inv-1", purpose: "treds" });
    const b = await requestConsent({}, { tenantId: "t1", invoiceId: "inv-1", purpose: "treds" });
    expect(a.consent_handle).toBe(b.consent_handle);
    expect(a.consent_handle).toMatch(/^sbx_/);
    expect(a.is_sandbox).toBe(true);
    expect(a.redirect_url).toContain("/api/aa/callback?sandbox=1&handle=");
  });

  it("requestConsent expiry is ~30 days from now", async () => {
    const r = await requestConsent({}, { tenantId: "t1", invoiceId: "inv-1" });
    const expires = new Date(r.expires_at).getTime();
    const delta = expires - Date.now();
    expect(delta).toBeGreaterThan(29 * 86400_000);
    expect(delta).toBeLessThan(31 * 86400_000);
  });

  it("pollConsent flips a sandbox handle to ACTIVE", async () => {
    const r = await pollConsent({}, "sbx_abc123");
    expect(r.status).toBe("ACTIVE");
    expect(r.granted_at).toBeTruthy();
    expect(r.is_sandbox).toBe(true);
  });

  it("fetchData returns a canned 6-month bank summary in sandbox", async () => {
    const r = await fetchData({}, "sbx_abc123");
    expect(r.summary.months).toBe(6);
    expect(r.summary.average_balance_inr).toBeGreaterThan(0);
    expect(r.is_sandbox).toBe(true);
  });

  it("verifyWebhook accepts everything in sandbox mode", () => {
    expect(verifyWebhook({ settings: {}, rawBody: "x", signature: "" })).toEqual({
      ok: true, sandbox: true,
    });
  });

  it("verifyWebhook requires a real HMAC outside sandbox", () => {
    // To exit sandbox mode we need both client_id and client_secret
    // present (decryptCreds falls back to plaintext columns when
    // *_enc is not decryptable).
    const settings = {
      aa_provider: "setu",
      aa_client_id: "test-client-id",
      aa_client_secret: "test-secret-key",
    };
    const r = verifyWebhook({ settings, rawBody: "x", signature: "bad" });
    expect(r.ok).toBe(false);
  });
});

// -------------------- M1xchange sandbox -------------------------

describe("Bet 6 - M1xchange client sandbox state machine", () => {
  it("isConfigured + mode default to sandbox", () => {
    expect(m1xchangeIsConfigured({})).toBe(false);
    expect(m1xchangeMode({})).toBe("sandbox");
  });

  it("submitFactoring returns a stable sandbox external_factoring_id", async () => {
    const a = await submitFactoring({}, { tenantId: "t1", invoiceId: "inv-1", amountInr: 100000 });
    const b = await submitFactoring({}, { tenantId: "t1", invoiceId: "inv-1", amountInr: 100000 });
    expect(a.external_factoring_id).toBe(b.external_factoring_id);
    expect(a.external_factoring_id).toMatch(/^sbxf_/);
    expect(a.auction_status).toBe("submitted");
    expect(a.is_sandbox).toBe(true);
  });

  it("getAuctionStatus walks submitted -> live -> won by wall-clock", async () => {
    const start = 1_700_000_000_000;
    const r0 = await getAuctionStatus({}, "sbxf_abc", { start, nowMs: start, amountInr: 1000000 });
    const r2 = await getAuctionStatus({}, "sbxf_abc", { start, nowMs: start + 121_000, amountInr: 1000000 });
    const r5 = await getAuctionStatus({}, "sbxf_abc", { start, nowMs: start + 301_000, amountInr: 1000000 });
    expect(r0.status).toBe("submitted");
    expect(r2.status).toBe("live");
    expect(r5.status).toBe("won");
    expect(r5.best_rate_bps).toBe(1140);
    expect(r5.best_financier_name).toMatch(/Sandbox Financier/);
    expect(r5.net_amount_inr).toBeGreaterThan(0);
    expect(r5.net_amount_inr).toBeLessThan(1_000_000);    // we discounted something
  });

  it("acceptBestBid emits a sandbox UTR prefix + ~T+1 settlement", async () => {
    const r = await acceptBestBid({}, "sbxf_abc", { amountInr: 1_000_000 });
    expect(r.status).toBe("disbursed");
    expect(r.utr).toMatch(/^SBX[0-9A-F]+$/);
    expect(r.is_sandbox).toBe(true);
    const settle = new Date(r.settlement_at).getTime();
    expect(settle - Date.now()).toBeGreaterThan(82_000_000);     // > 22h
    expect(settle - Date.now()).toBeLessThan(90_000_000);
  });

  it("withdrawOffer is a no-op in sandbox", async () => {
    const r = await withdrawOffer({}, "sbxf_abc");
    expect(r.status).toBe("withdrawn");
    expect(r.is_sandbox).toBe(true);
  });

  it("getEligibleBuyers returns a canned 3-buyer set", async () => {
    const r = await getEligibleBuyers({});
    expect(r.length).toBe(3);
    expect(r.every((b) => b.gstin && b.name && b.active)).toBe(true);
  });

  it("sandboxAuctionState math: 1L invoice at 11.40% for 60d ~= Rs 1873 discount", () => {
    const s = m1Test.sandboxAuctionState({
      start: 0, nowMs: 999_999_999, amountInr: 100_000,
    });
    expect(s.status).toBe("won");
    // 100000 * 0.1140 * (60/365) ~= 1873.97
    expect(s.discount_inr).toBeCloseTo(1873.97, 1);
    // 100000 * 0.0015 = 150
    expect(s.fee_inr).toBeCloseTo(150, 1);
    expect(s.net_amount_inr).toBeCloseTo(100_000 - 1873.97, 1);
  });

  it("sandboxFactoringId is stable per (tenant, invoice)", () => {
    const a = m1Test.sandboxFactoringId({ tenantId: "x", invoiceId: "y" });
    const b = m1Test.sandboxFactoringId({ tenantId: "x", invoiceId: "y" });
    const c = m1Test.sandboxFactoringId({ tenantId: "x", invoiceId: "z" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sbxf_/);
  });
});

// -------------------- source contract ---------------------------

describe("Bet 6 - source contract regression", () => {
  const migration = SRC("supabase/migrations/102_aa_treds_sandbox.sql");
  const routerSrc = SRC("src/api/router.js");
  const clientSrc = SRC("src/client/anvil-client.js");
  const navSrc    = SRC("src/v3-app/lib/nav.ts");
  const rbacSrc   = SRC("src/v3-app/lib/rbac.ts");
  const routesSrc = SRC("src/v3-app/routes.ts");
  const consentSrc = SRC("src/api/aa/consent.js");
  const callbackSrc = SRC("src/api/aa/callback.js");
  const webhookSrc = SRC("src/api/aa/webhook.js");
  const offerSrc  = SRC("src/api/treds/offer.js");
  const acceptSrc = SRC("src/api/treds/accept.js");

  it("migration creates the four RLS-scoped tables", () => {
    expect(migration).toMatch(/create table if not exists aa_consents/);
    expect(migration).toMatch(/create table if not exists treds_offers/);
    expect(migration).toMatch(/create table if not exists treds_discounts/);
    expect(migration).toMatch(/create table if not exists treds_eligible_buyers/);
    expect(migration).toMatch(/enable row level security/);
  });

  it("migration enforces the provider + auction_status enums", () => {
    for (const v of ["setu", "finvu", "sandbox", "none"]) {
      expect(migration).toMatch(new RegExp("'" + v + "'"));
    }
    for (const v of ["m1xchange", "rxil", "invoicemart"]) {
      expect(migration).toMatch(new RegExp("'" + v + "'"));
    }
    for (const v of ["submitted", "live", "won", "no_bid"]) {
      expect(migration).toMatch(new RegExp("'" + v + "'"));
    }
  });

  it("migration adds invoices.discounted_via_treds_at without flipping status", () => {
    expect(migration).toMatch(/add column if not exists discounted_via_treds_at/);
    expect(migration).not.toMatch(/update invoices/i);
  });

  it("router routes all seven AA + TReDS endpoints", () => {
    expect(routerSrc).toMatch(/"\/aa\/consent"/);
    expect(routerSrc).toMatch(/"\/aa\/callback"/);
    expect(routerSrc).toMatch(/"\/aa\/webhook"/);
    expect(routerSrc).toMatch(/"\/treds\/offer"/);
    expect(routerSrc).toMatch(/"\/treds\/accept"/);
    expect(routerSrc).toMatch(/"\/treds\/list"/);
    expect(routerSrc).toMatch(/"\/treds\/eligible_buyers"/);
    expect(routerSrc).toMatch(/"\/treds\/eligible_buyers\/refresh"/);
  });

  it("anvil-client surfaces aa + treds modules with at least 10 methods", () => {
    expect(clientSrc).toMatch(/const aa = \{/);
    expect(clientSrc).toMatch(/const treds = \{/);
    for (const m of [
      "list:", "request:", "poll:", "submitOffer:", "refreshOffer:",
      "acceptOffer:", "eligibleBuyers:", "refreshEligibleBuyers:",
    ]) {
      expect(clientSrc).toContain(m);
    }
  });

  it("nav + rbac + routes carry the new treds entry", () => {
    expect(navSrc).toMatch(/id: "treds"/);
    expect(rbacSrc).toMatch(/treds:/);
    expect(routesSrc).toMatch(/treds:\s+lazy/);
    expect(routesSrc).toMatch(/treds:\s+\(\) => screens\.treds/);
  });

  it("AA consent endpoint requires admin for POST + audits the request", () => {
    expect(consentSrc).toMatch(/requirePermission\(ctx, "admin"\)/);
    expect(consentSrc).toMatch(/aa\.consent\.requested/);
    expect(consentSrc).toMatch(/sandbox_active/);
  });

  it("AA callback returns a self-closing HTML page that posts a parent message", () => {
    expect(callbackSrc).toMatch(/aa-consent-complete/);
    expect(callbackSrc).toMatch(/window\.opener/);
  });

  it("AA webhook reads the raw body and verifies HMAC outside sandbox", () => {
    expect(webhookSrc).toMatch(/readRawBody/);
    expect(webhookSrc).toMatch(/verifyWebhook/);
    expect(webhookSrc).toMatch(/x-setu-signature/);
  });

  it("TReDS offer endpoint requires INR + a buyer GSTIN + above min", () => {
    expect(offerSrc).toMatch(/TReDS supports INR invoices only/);
    expect(offerSrc).toMatch(/buyer GSTIN required/);
    expect(offerSrc).toMatch(/below tenant TReDS minimum/);
  });

  it("TReDS accept stamps invoices.discounted_via_treds_at + creates a discount", () => {
    expect(acceptSrc).toMatch(/discounted_via_treds_at:/);
    expect(acceptSrc).toMatch(/treds_discounts/);
    expect(acceptSrc).toMatch(/treds\.discount\.accepted/);
  });
});

// -------------------- helpers ----------------------------------

describe("Bet 6 - helpers", () => {
  it("setuTest.SANDBOX_PROVIDERS covers the empty / none / sandbox set", () => {
    expect(setuTest.SANDBOX_PROVIDERS.has("sandbox")).toBe(true);
    expect(setuTest.SANDBOX_PROVIDERS.has("none")).toBe(true);
    expect(setuTest.SANDBOX_PROVIDERS.has(null)).toBe(true);
    expect(setuTest.SANDBOX_PROVIDERS.has(undefined)).toBe(true);
    expect(setuTest.SANDBOX_PROVIDERS.has("setu")).toBe(false);
  });

  it("setuTest.sandboxHandle is deterministic + collision-resistant", () => {
    const a = setuTest.sandboxHandle({ tenantId: "x", invoiceId: "y", purpose: "z" });
    const b = setuTest.sandboxHandle({ tenantId: "x", invoiceId: "y", purpose: "z" });
    const c = setuTest.sandboxHandle({ tenantId: "x", invoiceId: "y", purpose: "different" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
