// quote_lines stores rates as FRACTIONS. The extractor speaks percentages.
//
// This mismatch made every GST-bearing quote fail to ingest, silently, since
// the attach path shipped. Migration 114 CHECKs that the five tax rates sum to
// <= 1.0 and names the exact failure it guards against — "entering 9 instead
// of 0.09" — and toQuoteLineRow passed the extractor's 9 straight through, so
// 9 + 9 = 18 and Postgres rejected the whole insert:
//
//   quote_lines insert: new row for relation "quote_lines" violates check
//   constraint "quote_lines_tax_rate_sum_check"
//
// Before the ingest reported its errors honestly, that surfaced as a quote
// head with zero lines and a cheerful "ingested: true".
//
// The same family of bug reached discount_pct: quote_lines_with_totals
// computes listed_unit_price * (1.0 - discount_pct), so a percentage there
// prices a discounted line at MINUS its list value.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { toQuoteLineRow } from "../api/_lib/quote-ingest.js";

// Verbatim from a real extraction run against a live quotation.
const REAL = {
  partNumber: "BP8/35", description: "Socket", quantity: 30, uom: "Nos",
  unitPrice: 1872, listUnitPrice: 1910, amount: 56160, listAmount: 57300,
  moq: 30, remark: "MOQ=30Nos", cgst_pct: 9, sgst_pct: 9, igst_pct: null,
};

const taxSum = (r) =>
  (r.cgst_pct || 0) + (r.sgst_pct || 0) + (r.igst_pct || 0);

describe("tax rates are stored as fractions", () => {
  it("converts 9% to 0.09", () => {
    const r = toQuoteLineRow(REAL, 0);
    expect(r.cgst_pct).toBe(0.09);
    expect(r.sgst_pct).toBe(0.09);
  });

  it("satisfies migration 114's CHECK, which the raw percentages did not", () => {
    // 9 + 9 = 18 > 1.0 -> Postgres rejected the insert and the quote landed
    // with no lines at all.
    expect(taxSum(toQuoteLineRow(REAL, 0))).toBeLessThanOrEqual(1.0);
    expect(taxSum(toQuoteLineRow(REAL, 0))).toBeCloseTo(0.18, 6);
  });

  it("keeps a null rate null rather than turning it into zero", () => {
    // igst absent on an intrastate sale is not the same fact as igst of 0%.
    expect(toQuoteLineRow(REAL, 0).igst_pct).toBeNull();
  });

  it("handles the full Indian GST ladder within the constraint", () => {
    for (const pct of [0.25, 3, 5, 12, 18, 28]) {
      const r = toQuoteLineRow({ partNumber: "X", igst_pct: pct }, 0);
      expect(r.igst_pct).toBeCloseTo(pct / 100, 6);
      expect(taxSum(r)).toBeLessThanOrEqual(1.0);
    }
  });

  it("survives the worst legal split without exceeding 1.0", () => {
    // 28% IGST plus a 22% cess is the heaviest real combination.
    const r = toQuoteLineRow({ partNumber: "X", cgst_pct: 14, sgst_pct: 14 }, 0);
    expect(taxSum(r)).toBeCloseTo(0.28, 6);
  });

  it("keeps six decimals, matching numeric(8,6)", () => {
    const r = toQuoteLineRow({ partNumber: "X", igst_pct: 0.25 }, 0);
    expect(r.igst_pct).toBe(0.0025);
  });
});

describe("discount_pct is a fraction, because the view subtracts it from 1", () => {
  it("derives 1910 -> 1872 as ~0.0199, not 1.99", () => {
    const r = toQuoteLineRow(REAL, 0);
    expect(r.discount_pct).toBeGreaterThan(0);
    expect(r.discount_pct).toBeLessThan(1);
    expect(r.discount_pct).toBeCloseTo(0.0199, 4);
  });

  it("round-trips through the view's own arithmetic", () => {
    // quote_lines_with_totals: listed_unit_price * (1.0 - discount_pct).
    // With a percentage this produced 1910 * (1 - 1.99) = -1890.9.
    const r = toQuoteLineRow(REAL, 0);
    expect(r.listed_unit_price * (1 - r.discount_pct)).toBeCloseTo(1872, 2);
  });

  it("is null when there was no separate list price", () => {
    const r = toQuoteLineRow({ partNumber: "X", unitPrice: 100, quantity: 1 }, 0);
    expect(r.discount_pct).toBeNull();
    expect(r.listed_unit_price).toBe(100);
    expect(r.discounted_unit_price).toBe(100);
  });

  it("is null rather than negative when the 'discounted' price is higher", () => {
    const r = toQuoteLineRow({ partNumber: "X", unitPrice: 200, listUnitPrice: 100 }, 0);
    expect(r.discount_pct).toBeNull();
  });
});

describe("the constraint this is measured against", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/114_quote_lines_tax_rate_sum_check.sql"), "utf8");

  it("still bounds the sum at 1.0", () => {
    // If this ever becomes 100, the conversion above is wrong instead.
    expect(sql).toMatch(/<=\s*1\.0/);
  });

  it("names the failure mode this fix prevents", () => {
    expect(sql).toMatch(/9.*instead of.*0\.09/i);
  });
});
