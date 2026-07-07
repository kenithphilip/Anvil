// Auto PO->quote reconciliation engine (money-critical). Pure-function
// tests: multi-quote matching, price/qty exceptions, unmatched, ambiguity,
// part-no normalization, and field enrichment/provenance.

import { describe, it, expect } from "vitest";
import { reconcilePoAgainstQuotes } from "../api/_lib/quote-reconcile.js";

// Two quotes for the same customer; a PO draws lines from BOTH.
const ql = (quote_id, quote_number, created_at, part_no, extra = {}) => ({
  _quote_id: quote_id, _quote_number: quote_number, _quote_created_at: created_at,
  part_no, description: extra.description || part_no, qty: extra.qty ?? 1, uom: "Nos",
  hsn_sac: extra.hsn_sac || "85159000", customer_part_number: extra.customer_part_number || null,
  source_country: extra.source_country || null, listed_unit_price: extra.listed ?? null,
  discount_pct: extra.discount_pct ?? null, discounted_unit_price: extra.rate,
  cgst_pct: extra.cgst_pct ?? 9, sgst_pct: extra.sgst_pct ?? 9, igst_pct: null,
});

const QUOTES = [
  // most recent first (preferred)
  ql("qB", "Q-B", "2026-02-01", "403A7K188-100", { rate: 27244, hsn_sac: "85159000" }),
  ql("qB", "Q-B", "2026-02-01", "303S1002KS", { rate: 16640.4 }),
  ql("qA", "Q-A", "2026-01-01", "4-ET10115", { rate: 3028.2, source_country: "O-JAPAN" }),
  ql("qA", "Q-A", "2026-01-01", "303S1002KS", { rate: 15000 }), // older price for a dup part -> ambiguous
];

describe("reconcilePoAgainstQuotes", () => {
  it("matches PO lines across MULTIPLE quotes and enriches + tags provenance", () => {
    const po = [
      { line_no: 1, part_no: "403A7K188-100", qty: 2, rate: 27244 },  // from Q-B
      { line_no: 2, part_no: "4-ET10115", qty: 1, rate: 3028.2 },     // from Q-A
    ];
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    expect(r.summary.matched).toBe(2);
    expect(r.summary.unmatched).toBe(0);
    // provenance: line 1 <- Q-B, line 2 <- Q-A
    expect(r.lines[0].source_quote_number).toBe("Q-B");
    expect(r.lines[1].source_quote_number).toBe("Q-A");
    // enrichment carried from the quote
    expect(r.lines[0].hsn).toBe("85159000");
    expect(r.lines[0].discounted_unit_price).toBe(27244);
    expect(r.lines[0].cgst_pct).toBe(9);
    expect(r.lines[1].source_country).toBe("O-JAPAN");
    // both quotes credited
    expect(r.quotes_used.map((q) => q.quote_number).sort()).toEqual(["Q-A", "Q-B"]);
  });

  it("flags a PRICE mismatch when the PO rate differs from the quoted rate", () => {
    const po = [{ line_no: 1, part_no: "403A7K188-100", qty: 2, rate: 30000 }]; // quote is 27244
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    expect(r.summary.price_mismatch).toBe(1);
    expect(r.lines[0]._match.verdict).toBe("price_mismatch");
    expect(r.lines[0]._match.quote_rate).toBe(27244);
    expect(r.lines[0]._match.price_delta_pct).toBeGreaterThan(0);
    expect(r.flags[0].verdict).toBe("price_mismatch");
    // discounted_unit_price is set to the QUOTE (authoritative) rate, not the PO's
    expect(r.lines[0].discounted_unit_price).toBe(27244);
  });

  it("reports UNMATCHED PO lines (part not in any quote)", () => {
    const po = [{ line_no: 1, part_no: "NOT-IN-ANY-QUOTE", qty: 1, rate: 100 }];
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    expect(r.summary.unmatched).toBe(1);
    expect(r.lines[0]._match.verdict).toBe("unmatched");
    expect(r.flags[0].verdict).toBe("unmatched");
  });

  it("prefers the most-recent quote for a duplicated part and flags it ambiguous", () => {
    const po = [{ line_no: 1, part_no: "303S1002KS", qty: 1, rate: 16640.4 }];
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    // Q-B (2026-02) preferred over Q-A (2026-01)
    expect(r.lines[0].source_quote_number).toBe("Q-B");
    expect(r.lines[0].discounted_unit_price).toBe(16640.4);
    expect(r.lines[0]._match.ambiguous).toBe(true);
    expect(r.ambiguous_parts).toContain("303S1002KS");
  });

  it("normalizes part numbers (spaces/dashes/case) when matching", () => {
    const po = [{ line_no: 1, part_no: "403 a7k188 100", qty: 1, rate: 27244 }];
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    expect(r.lines[0]._match.verdict).toBe("matched");
    expect(r.lines[0]._match.exact).toBe(false); // matched via normalization, not exact
    expect(r.lines[0].source_quote_number).toBe("Q-B");
  });

  it("keeps the PO's own customer_part_number (the SO Cust Part No)", () => {
    const po = [{ line_no: 1, part_no: "403A7K188-100", qty: 2, rate: 27244, customer_part_number: "GD544202503040002" }];
    const r = reconcilePoAgainstQuotes(po, QUOTES);
    expect(r.lines[0].customer_part_number).toBe("GD544202503040002");
  });
});
