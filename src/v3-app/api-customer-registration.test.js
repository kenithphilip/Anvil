// Unit tests for src/api/_lib/customer-registration.js — the categorized
// customer-registration field catalog + grouping/completeness helpers.

import { describe, it, expect } from "vitest";
import {
  CATEGORIES, FIELD_CATALOG, FIELD_KEYS, isValidFieldKey,
  groupByCategory, completeness, normalizeFieldInput,
} from "../api/_lib/customer-registration.js";

describe("catalog integrity", () => {
  it("every field belongs to a known category", () => {
    const cats = new Set(CATEGORIES.map((c) => c.key));
    for (const f of FIELD_CATALOG) expect(cats.has(f.category)).toBe(true);
  });
  it("field keys are unique", () => {
    expect(FIELD_KEYS.size).toBe(FIELD_CATALOG.length);
  });
  it("has the GST-first mandatory spine", () => {
    for (const k of ["gstin", "legal_name", "pan", "state_code", "customer_type", "currency", "payment_terms"]) {
      expect(isValidFieldKey(k)).toBe(true);
    }
  });
  it("rejects unknown keys", () => {
    expect(isValidFieldKey("not_a_field")).toBe(false);
    expect(isValidFieldKey("lst_registration_no")).toBe(false); // obsolete pre-GST field, intentionally dropped
  });
});

describe("groupByCategory", () => {
  it("returns all categories with catalog fields and merged values", () => {
    const rows = [
      { field_key: "gstin", value: "27AAACO8335K1Z5", source: "gst", verified: true, verified_against: "gst_certificate", updated_at: "2026-06-27" },
      { field_key: "bank_ifsc", value: "ICIC0000321", source: "doc", verified: true, verified_against: "cancelled_cheque", updated_at: "2026-06-27" },
    ];
    const grouped = groupByCategory(rows);
    expect(grouped.map((c) => c.key)).toEqual(CATEGORIES.map((c) => c.key));

    const statutory = grouped.find((c) => c.key === "statutory_identity");
    const gstin = statutory.fields.find((f) => f.key === "gstin");
    expect(gstin).toMatchObject({ value: "27AAACO8335K1Z5", source: "gst", verified: true, verified_against: "gst_certificate", mandatory: true });

    const banking = grouped.find((c) => c.key === "banking");
    const ifsc = banking.fields.find((f) => f.key === "bank_ifsc");
    expect(ifsc.value).toBe("ICIC0000321");

    // Unfilled field comes back with null value, not missing.
    const tradeName = statutory.fields.find((f) => f.key === "trade_name");
    expect(tradeName.value).toBeNull();
    expect(tradeName.verified).toBe(false);
  });
});

describe("completeness", () => {
  it("is 0% with no rows and 100% when all mandatory filled", () => {
    expect(completeness([]).pct).toBe(0);
    const mandatoryKeys = FIELD_CATALOG.filter((f) => f.mandatory).map((f) => f.key);
    const rows = mandatoryKeys.map((k) => ({ field_key: k, value: "x" }));
    const c = completeness(rows);
    expect(c.pct).toBe(100);
    expect(c.missing).toEqual([]);
    expect(c.mandatory_filled).toBe(c.mandatory_total);
  });
  it("ignores blank values and lists what's missing", () => {
    const c = completeness([{ field_key: "gstin", value: "  " }]);
    expect(c.mandatory_filled).toBe(0);
    expect(c.missing).toContain("gstin");
  });
});

describe("normalizeFieldInput", () => {
  it("accepts a raw scalar -> manual/unverified", () => {
    expect(normalizeFieldInput("Obara India")).toEqual({ value: "Obara India", source: "manual", verified: false, verified_against: null });
  });
  it("accepts an object with source/verified", () => {
    expect(normalizeFieldInput({ value: "27AAACO8335K1Z5", source: "gst", verified: true, verified_against: "gst_certificate" }))
      .toEqual({ value: "27AAACO8335K1Z5", source: "gst", verified: true, verified_against: "gst_certificate" });
  });
  it("defaults an unknown source to manual", () => {
    expect(normalizeFieldInput({ value: "x", source: "bogus" }).source).toBe("manual");
  });
});
