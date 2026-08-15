// The tenant's own registered identity.
//
// Migration 062 added these columns because the e-invoice handler had ONE
// tenant's seller block hardcoded, so every other tenant shipped GSTN a payload
// claiming to be someone else. The columns landed; a way to fill them in did
// not — nothing in the app ever wrote them, and raw SQL against tenant_settings
// is not something you can ask a customer to do.
//
// Two properties matter here beyond "it saves":
//   1. The PATCH allow-list. tenant_settings holds provider keys and feature
//      flags on the same row, and a PATCH body is attacker-controlled.
//   2. Validation that refuses only what is unambiguously wrong. An operator
//      transcribing a GST certificate can see the value they typed; they
//      cannot see why a form rejected it.

import { describe, it, expect } from "vitest";
import { SELLER_FIELDS, validateSeller, missingForPdf, PDF_REQUIRED } from "../api/admin/seller_details.js";

describe("the field allow-list", () => {
  it("covers exactly what migration 062 added, plus cin/pan for the PDF", () => {
    expect(SELLER_FIELDS).toContain("einvoice_seller_legal_name");
    expect(SELLER_FIELDS).toContain("einvoice_seller_gstin");
    expect(SELLER_FIELDS).toContain("cin");
    expect(SELLER_FIELDS).toContain("pan");
    expect(SELLER_FIELDS).toHaveLength(12);
  });

  // tenant_settings carries docai provider keys, feature flags and the LLM
  // routing config on the same row. A patch that spread the body would be a
  // privilege-escalation surface, not a form.
  it.each([
    "docai_llamacloud_api_key_enc", "so_agent_enabled", "docai_provider_order",
    "tenant_id", "docai_daily_limits", "llm_provider",
  ])("does not expose %s", (f) => {
    expect(SELLER_FIELDS).not.toContain(f);
  });
});

describe("validation refuses only what is unambiguously wrong", () => {
  it("accepts a well-formed set", () => {
    expect(validateSeller({
      einvoice_seller_gstin: "27AAACM3025E1ZZ",
      einvoice_seller_state_code: "27",
      einvoice_seller_pincode: "411018",
      pan: "AAACM3025E",
      cin: "L65990MH1945PLC004558",
    })).toEqual([]);
  });

  it("accepts an entirely empty patch — partial completion is normal", () => {
    // An operator fills this in over two sittings; a form that demands
    // everything at once gets abandoned half-done.
    expect(validateSeller({})).toEqual([]);
    expect(validateSeller({ einvoice_seller_legal_name: "ACME LTD" })).toEqual([]);
  });

  it("rejects a malformed GSTIN", () => {
    const e = validateSeller({ einvoice_seller_gstin: "NOTAGSTIN" });
    expect(e).toHaveLength(1);
    expect(e[0].field).toBe("einvoice_seller_gstin");
    expect(e[0].message).toMatch(/15 characters/);
  });

  it.each([["PAN", { pan: "BAD" }], ["CIN", { cin: "NOPE" }], ["PIN", { einvoice_seller_pincode: "0123" }]])(
    "rejects a malformed %s", (_n, patch) => {
      expect(validateSeller(patch)).toHaveLength(1);
    },
  );

  it("rejects a PIN starting with zero, which India does not issue", () => {
    expect(validateSeller({ einvoice_seller_pincode: "011018" })).toHaveLength(1);
    expect(validateSeller({ einvoice_seller_pincode: "411018" })).toEqual([]);
  });

  // The state code is the GSTIN's first two characters. Disagreement means one
  // of them is wrong, and GSTN rejects the payload — better to catch it here
  // than on a filing.
  it("catches a state code that contradicts the GSTIN", () => {
    const e = validateSeller({ einvoice_seller_gstin: "27AAACM3025E1ZZ", einvoice_seller_state_code: "29" });
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/does not match the GSTIN/);
  });

  it("does not cross-check when only one of the two is supplied", () => {
    expect(validateSeller({ einvoice_seller_gstin: "27AAACM3025E1ZZ" })).toEqual([]);
    expect(validateSeller({ einvoice_seller_state_code: "27" })).toEqual([]);
  });

  it("says what good looks like, not just that it refused", () => {
    // A message an operator can act on beats "invalid".
    for (const e of validateSeller({ pan: "X", cin: "Y", einvoice_seller_pincode: "1" })) {
      expect(e.message).toMatch(/e\.g\.|must be/);
    }
  });
});

describe("missingForPdf", () => {
  const full = {
    einvoice_seller_legal_name: "ACME LTD", einvoice_seller_gstin: "27AAACM3025E1ZZ",
    einvoice_seller_address_line1: "Plot 1", einvoice_seller_state_code: "27",
  };

  it("is empty when the PDF has what it needs", () => {
    expect(missingForPdf(full)).toEqual([]);
  });

  it("names every field a customer-facing PDF is missing", () => {
    expect(missingForPdf({})).toEqual([...PDF_REQUIRED]);
  });

  it("treats whitespace as missing — a space is not a legal name", () => {
    expect(missingForPdf({ ...full, einvoice_seller_legal_name: "   " }))
      .toContain("einvoice_seller_legal_name");
  });

  it("does not demand the optional fields", () => {
    // Trade name, line 2, phone, CIN and PAN are genuinely optional; requiring
    // them would block a tenant that legitimately has none.
    expect(missingForPdf(full)).toEqual([]);
    expect(PDF_REQUIRED).not.toContain("einvoice_seller_trade_name");
    expect(PDF_REQUIRED).not.toContain("cin");
  });

  it.each([null, undefined])("returns the full list for %p rather than throwing", (v) => {
    expect(missingForPdf(v)).toEqual([...PDF_REQUIRED]);
  });
});
