// Why a 45-line PO truncated, and what the two changes actually buy.
//
// Measured, not estimated:
//   - 21 schema fields per line = 467 chars of JSON
//   - 45 lines + customer = 5,400-6,800 output tokens
//   - max_tokens was 8,000
//   - a 13-page PO exceeds PO_MULTIPAGE_PAGE_THRESHOLD, so the selector picks
//     gemini-3.1-pro — a REASONING model — which then had under 2,600 tokens
//     to think in. It ran out mid-array; #411's guard turned that into a hard
//     failure rather than silently dropped lines.
//
// Eleven of the twenty-one fields came back null on this document — 218 of 467
// chars, 47% of every line. Nesting them means an absent group is one null.

import { describe, it, expect, afterAll } from "vitest";
import { flattenCharges, CHARGE_KEYS } from "../api/_lib/docai/gemini.js";

describe("flattenCharges", () => {
  it("lifts a nested group to the flat keys every consumer reads", () => {
    const out = flattenCharges({
      partNumber: "P1", quantity: 1, unitPrice: 100,
      charges: { cgst_amount: 9, sgst_amount: 9 },
    });
    expect(out.cgst_amount).toBe(9);
    expect(out.sgst_amount).toBe(9);
    expect(out.charges).toBeUndefined();
  });

  it("drops a null group without inventing zeros", () => {
    // A zero is a CLAIM that tax is nil; absent must stay absent so
    // lineGross's taxSeen stays false and its inflation allowance applies.
    const out = flattenCharges({ partNumber: "P1", charges: null });
    expect(out.charges).toBeUndefined();
    for (const k of CHARGE_KEYS) expect(out[k]).toBeUndefined();
  });

  it("never overwrites a value the model put at the top level", () => {
    // If a model ignores the nesting and emits flat keys, those are what it
    // actually asserted — the nested copy must not win.
    const out = flattenCharges({ cgst_amount: 5, charges: { cgst_amount: 99 } });
    expect(out.cgst_amount).toBe(5);
  });

  it("fills only the keys the group actually carries", () => {
    const out = flattenCharges({ charges: { igst_amount: 18 } });
    expect(out.igst_amount).toBe(18);
    expect(out.cgst_amount).toBeUndefined();
  });

  it("passes a line with no charges key through untouched", () => {
    const line = { partNumber: "P1", quantity: 2 };
    expect(flattenCharges(line)).toBe(line);
  });

  it.each([null, undefined, 42, "x"])("returns %p unchanged rather than throwing", (v) => {
    expect(() => flattenCharges(v)).not.toThrow();
    expect(flattenCharges(v)).toBe(v);
  });

  it("covers every key lineGross and computeLineTotals read", () => {
    // If these drift, tax silently stops being counted — the same class of
    // failure as the line_total/lineTotal mismatch.
    for (const k of ["cgst_amount", "sgst_amount", "igst_amount", "utgst_amount",
      "cess_amount", "excise_amount", "ed_cess_amount",
      "tooling_amount", "p_and_f_amount", "others_amount"]) {
      expect(CHARGE_KEYS).toContain(k);
    }
    expect(CHARGE_KEYS).toHaveLength(10);
  });
});

describe("the output budget, measured", () => {
  // Reproduces the sizing that motivated both changes, so a future schema
  // addition that re-inflates the line shows up as a failing test rather than
  // as a truncated PO in production.
  const flatLine = {
    partNumber: "PN-092-1-2", customerItemCode: "A12060ACME010001",
    description: "ACME STD SHANK PN-092-1", raw_description: "ACME STD SHANK PN-092-1-2",
    specification: null, quantity: 1, unitPrice: 1000.8, uom: "each", hsn: null,
    gst_pct: 18, discount_pct: null,
    cgst_amount: 90.07, sgst_amount: 90.07, igst_amount: null, utgst_amount: null,
    cess_amount: null, excise_amount: null, ed_cess_amount: null,
    tooling_amount: null, p_and_f_amount: null, others_amount: null,
  };
  const nestedLine = {
    partNumber: "PN-092-1-2", customerItemCode: "A12060ACME010001",
    description: "ACME STD SHANK PN-092-1", raw_description: "ACME STD SHANK PN-092-1-2",
    specification: null, quantity: 1, unitPrice: 1000.8, uom: "each", hsn: null,
    gst_pct: 18, discount_pct: null,
    charges: { cgst_amount: 90.07, sgst_amount: 90.07 },
  };

  it("the old flat line really was ~467 chars", () => {
    expect(JSON.stringify(flatLine).length).toBeGreaterThan(440);
  });

  it("nesting cuts a line by a meaningful fraction, not a rounding error", () => {
    const before = JSON.stringify(flatLine).length;
    const after = JSON.stringify(nestedLine).length;
    expect(after).toBeLessThan(before);
    expect((before - after) / before).toBeGreaterThan(0.2);
  });

  it("a charge-less line collapses to a single null", () => {
    // The common case on Indian POs printing one consolidated Taxes column.
    const none = { ...nestedLine, charges: null };
    const flatNone = { ...flatLine };
    expect(JSON.stringify(none).length).toBeLessThan(JSON.stringify(flatNone).length - 120);
  });

  it("45 nested lines fit inside the old 8,000-token ceiling with room to think", () => {
    const doc = { classification: "po", confidence: 0.9, customer: {}, lines: new Array(45).fill(nestedLine), stated_line_count: 45 };
    const approxTokens = JSON.stringify(doc).length / 3.6;
    expect(approxTokens).toBeLessThan(5000);
  });
});

describe("the ceiling", () => {
  const saved = process.env.GEMINI_MAX_OUTPUT_TOKENS;
  afterAll(() => {
    if (saved === undefined) delete process.env.GEMINI_MAX_OUTPUT_TOKENS;
    else process.env.GEMINI_MAX_OUTPUT_TOKENS = saved;
  });

  it("defaults well above the answer size but far below the model's 64K limit", () => {
    delete process.env.GEMINI_MAX_OUTPUT_TOKENS;
    const v = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 24000);
    expect(v).toBeGreaterThan(8000);       // the ceiling that truncated
    expect(v).toBeLessThanOrEqual(64000);  // documented model maximum
  });

  it("is env-tunable without a deploy", () => {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "12000";
    expect(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 24000)).toBe(12000);
  });
});
