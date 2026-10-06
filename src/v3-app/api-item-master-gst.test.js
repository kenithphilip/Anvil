// GST entered on an item has to reach the voucher.
//
// item_master collects TWO GST vocabularies on the same form: the split rates
// (sgst_rate / cgst_rate / igst_rate) and a single rate_of_duty_pct. Only
// rate_of_duty_pct was read when building a Tally voucher, and the item mapper
// only carried that one onto the line. So an operator who filled SGST 9 / CGST 9
// — the natural thing for a domestic item — and left "Rate of duty %" blank got
// a voucher taxed at 0%, with nothing anywhere saying so.
//
// The audit reported this as "GST rates are never used". That was half right:
// rate_of_duty_pct always worked. The defect is that two fields on one form
// silently disagree about which one is load-bearing.

import { describe, it, expect } from "vitest";
import { computeLineTax, splitRateTotal } from "../api/_lib/tally-build-voucher.js";

const line = (over = {}) => ({ qty: 10, rate: 100, ...over });

describe("splitRateTotal", () => {
  it("uses IGST as the whole rate on an interstate supply", () => {
    expect(splitRateTotal({ igst_rate: 18 })).toBe(18);
  });

  it("adds SGST and CGST, which are half each of the same total", () => {
    expect(splitRateTotal({ sgst_rate: 9, cgst_rate: 9 })).toBe(18);
  });

  it("prefers IGST when both are present, rather than summing all three", () => {
    // Items commonly carry all three; 9 + 9 + 18 would be 36% tax.
    expect(splitRateTotal({ sgst_rate: 9, cgst_rate: 9, igst_rate: 18 })).toBe(18);
  });

  it("returns null, not 0, when there is nothing to derive", () => {
    // 0 would satisfy `??` and pin the rate at zero, which is the exact bug.
    expect(splitRateTotal({})).toBeNull();
    expect(splitRateTotal({ sgst_rate: 0, cgst_rate: 0 })).toBeNull();
    expect(splitRateTotal(null)).toBeNull();
    expect(splitRateTotal({ sgst_rate: "abc" })).toBeNull();
  });

  it("tolerates a half being absent", () => {
    expect(splitRateTotal({ sgst_rate: 9 })).toBe(9);
  });
});

describe("computeLineTax picks up the item's GST", () => {
  // The regression.
  it("taxes a line whose item has only split rates", () => {
    const t = computeLineTax(line({ _mapped_item: { sgst_rate: 9, cgst_rate: 9 } }), "intrastate");
    expect(t.gst_pct).toBe(18);
    expect(t.taxable).toBe(1000);
    expect(t.cgst + t.sgst).toBeCloseTo(180, 2);
  });

  it("taxes an interstate line from the item's IGST", () => {
    const t = computeLineTax(line({ _mapped_item: { igst_rate: 18 } }), "interstate");
    expect(t.gst_pct).toBe(18);
    expect(t.igst).toBeCloseTo(180, 2);
  });

  it("still prefers an explicit rate on the line", () => {
    // A PO that states its own rate wins over the master.
    const t = computeLineTax(line({ gst_pct: 5, _mapped_item: { sgst_rate: 9, cgst_rate: 9 } }), "intrastate");
    expect(t.gst_pct).toBe(5);
  });

  it("still prefers rate_of_duty_pct over the split rates", () => {
    // Unchanged behaviour: the explicit total remains canonical.
    const t = computeLineTax(line({ _mapped_item: { rate_of_duty_pct: 12, sgst_rate: 9, cgst_rate: 9 } }), "intrastate");
    expect(t.gst_pct).toBe(12);
  });

  it("reads split rates off the line itself when there is no mapped item", () => {
    const t = computeLineTax(line({ igst_rate: 28 }), "interstate");
    expect(t.gst_pct).toBe(28);
  });

  it("is still 0% for a genuinely untaxed line", () => {
    // Deriving must not invent tax where the item carries none.
    const t = computeLineTax(line({ _mapped_item: { part_no: "X" } }), "intrastate");
    expect(t.gst_pct).toBe(0);
    expect(t.cgst).toBe(0);
    expect(t.sgst).toBe(0);
    expect(t.igst).toBe(0);
  });
});
