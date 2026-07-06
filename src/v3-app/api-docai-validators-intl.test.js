// Country-conditional validator tests.
//
// Pure unit tests for the rules added with migration 096. The
// validator now treats NULL country as IN (back-compat) but
// supports KR / JP / DE / US / EU customers with tax_id +
// tax_id_type instead of GSTIN.
//
// Bug being prevented: an Northwind Korea PO returning gstin=null was
// previously NOT a validator finding, but the customer record would
// have had no canonical id at all because the schema only stored
// GSTIN. This test pins down that:
//   - country!=IN with gstin set is a 'gstin_unexpected' warn,
//   - country!=IN with bad tax_id_type is a 'tax_id_type_unknown' warn,
//   - currency country-mismatch is a warn (e.g. country=JP currency=INR),
//   - name-not-in-bill-to is a warn (the Northwind -> Meridian bug).

import { describe, it, expect } from "vitest";
import { __test } from "../api/_lib/docai/validators.js";

const { validateCustomer, checkCountry, checkCurrency, checkTaxIdType } = __test;

describe("validators / checkCountry", () => {
  it("accepts a 2-letter ISO code", () => {
    expect(checkCountry("IN")).toBeNull();
    expect(checkCountry("KR")).toBeNull();
    expect(checkCountry("JP")).toBeNull();
  });
  it("accepts null / empty (treated as IN downstream)", () => {
    expect(checkCountry(null)).toBeNull();
    expect(checkCountry("")).toBeNull();
  });
  it("warns on malformed", () => {
    const r = checkCountry("KOR");
    expect(r?.code).toBe("country_malformed");
  });
});

describe("validators / checkCurrency country-aware", () => {
  it("accepts KRW for KR", () => {
    expect(checkCurrency("KRW", "KR")).toBeNull();
  });
  it("accepts USD universally (cross-border default)", () => {
    expect(checkCurrency("USD", "JP")).toBeNull();
    expect(checkCurrency("USD", "IN")).toBeNull();
  });
  it("flags INR on a Japanese PO", () => {
    const r = checkCurrency("INR", "JP");
    expect(r?.code).toBe("currency_country_mismatch");
  });
  it("accepts EUR for German country", () => {
    expect(checkCurrency("EUR", "DE")).toBeNull();
  });
});

describe("validators / checkTaxIdType", () => {
  it("accepts the known enum values", () => {
    for (const t of ["pan", "brn", "jp_corp", "eu_vat", "us_ein", "de_steuernummer", "other"]) {
      expect(checkTaxIdType(t)).toBeNull();
    }
  });
  it("warns on unknown type", () => {
    const r = checkTaxIdType("vat_be");
    expect(r?.code).toBe("tax_id_type_unknown");
  });
  it("accepts null", () => {
    expect(checkTaxIdType(null)).toBeNull();
  });
});

describe("validators / validateCustomer country-conditional", () => {
  it("Indian customer with valid GSTIN passes", () => {
    const issues = validateCustomer({
      name: "Tata Steel Ltd",
      country: "IN",
      gstin: "27AABCT1234E1Z5",
      state_code: "27",
      currency: "INR",
      bill_to_address: "Tata Steel Ltd, Mumbai 400001",
    });
    expect(issues).toEqual([]);
  });

  it("Indian customer with no country (legacy) still treated as IN", () => {
    // Back-compat: extractor outputs from before migration 096 don't
    // carry country. Should validate as Indian, no errors.
    const issues = validateCustomer({
      name: "Tata Steel Ltd",
      gstin: "27AABCT1234E1Z5",
      state_code: "27",
      currency: "INR",
      bill_to_address: "Tata Steel Ltd, Mumbai 400001",
    });
    expect(issues).toEqual([]);
  });

  it("KR customer with GSTIN set is a gstin_unexpected warn", () => {
    const issues = validateCustomer({
      name: "Northwind Korea Co Ltd",
      country: "KR",
      gstin: "27FAKE12345E1Z5",                    // hallucinated
      tax_id: "123-45-67890",
      tax_id_type: "brn",
      currency: "KRW",
      bill_to_address: "Northwind Korea Co Ltd, Seoul",
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("gstin_unexpected");
  });

  it("KR customer with valid tax_id_type passes (modulo gstin warn)", () => {
    const issues = validateCustomer({
      name: "Northwind Korea Co Ltd",
      country: "KR",
      gstin: null,
      tax_id: "123-45-67890",
      tax_id_type: "brn",
      currency: "KRW",
      bill_to_address: "Northwind Korea Co Ltd, Seoul, South Korea",
    });
    expect(issues).toEqual([]);
  });

  it("KR customer with bad tax_id_type warns", () => {
    const issues = validateCustomer({
      name: "Northwind Korea Co Ltd",
      country: "KR",
      tax_id: "123-45-67890",
      tax_id_type: "vat_kr",                       // not in enum
      currency: "KRW",
      bill_to_address: "Northwind Korea Co Ltd",
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("tax_id_type_unknown");
  });

  it("name-not-in-bill-to warns (the Northwind -> Meridian regression case)", () => {
    // The LLM extracted Meridian (project / end-customer) as the
    // customer name, but bill-to says Northwind. Validator should flag.
    const issues = validateCustomer({
      name: "Meridian Steel",
      country: "KR",
      tax_id: "123-45-67890",
      tax_id_type: "brn",
      currency: "KRW",
      bill_to_address: "Northwind Korea Co Ltd, 1-2 Industrial Park, Seoul",
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("name_not_in_bill_to");
  });

  it("name-in-bill-to does NOT warn", () => {
    const issues = validateCustomer({
      name: "Northwind Korea Co Ltd",
      country: "KR",
      tax_id: "123-45-67890",
      tax_id_type: "brn",
      currency: "KRW",
      bill_to_address: "Northwind Korea Co Ltd, 1-2 Industrial Park, Seoul",
    });
    expect(issues.find((i) => i.code === "name_not_in_bill_to")).toBeUndefined();
  });

  it("currency_country_mismatch fires on JP+INR", () => {
    const issues = validateCustomer({
      name: "Northwind Japan KK",
      country: "JP",
      tax_id: "1234567890123",
      tax_id_type: "jp_corp",
      currency: "INR",                            // wrong for Japan
      bill_to_address: "Northwind Japan KK, Tokyo",
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("currency_country_mismatch");
  });
});
