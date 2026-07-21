// CM P4: the golden-set scorer foundation — the shape adapters that let the
// harness compare an approved order OR a raw pipeline extract against a golden
// `expected`, plus the scorer's new precision guard.

import { describe, it, expect } from "vitest";
import {
  lineToScorable,
  salesOrderToScorable,
  normalizedToScorable,
} from "../api/eval/eval-normalize.js";
import { scoreCase } from "../api/eval/run.js";

describe("lineToScorable", () => {
  it("maps the camelCase extractor line shape", () => {
    expect(lineToScorable({ partNumber: "TWS-092-90-2", quantity: 5, unitPrice: 100, hsn: "8207", description: "SHANK" }))
      .toEqual({ partNo: "TWS-092-90-2", itemName: "SHANK", qty: 5, rate: 100, hsn: "8207" });
  });
  it("maps the short convert.js line shape", () => {
    expect(lineToScorable({ partNo: "P1", qty: 2, rate: 50, hsn_sac: "8482", itemName: "BEARING" }))
      .toEqual({ partNo: "P1", itemName: "BEARING", qty: 2, rate: 50, hsn: "8482" });
  });
  it("carries the buyer SAP code through when present", () => {
    expect(lineToScorable({ partNumber: "OURS", customerItemCode: "A12060OBAR010003" }).customerItemCode)
      .toBe("A12060OBAR010003");
  });
  it("omits absent fields rather than emitting nulls", () => {
    expect(lineToScorable({ partNumber: "X" })).toEqual({ partNo: "X" });
  });
});

describe("salesOrderToScorable", () => {
  it("lifts a nested customer object + camelCase lines into the scorer vocabulary", () => {
    const out = salesOrderToScorable({
      customer: { name: "MAHINDRA & MAHINDRA LTD", po_number: "0066026562", po_date: "4/8/2026" },
      lineItems: [{ partNumber: "TWS-092-90-2", quantity: 5, unitPrice: 100 }],
    });
    expect(out.poNumber).toBe("0066026562");
    expect(out.poDate).toBe("4/8/2026");
    expect(out.customer).toBe("MAHINDRA & MAHINDRA LTD");
    expect(out.lineItems).toEqual([{ partNo: "TWS-092-90-2", qty: 5, rate: 100 }]);
  });
  it("accepts a flat customer string + already-short lines + grand total", () => {
    const out = salesOrderToScorable({
      customer: "Summit Automation", poNumber: "PO-1", grandTotal: 248500,
      lineItems: [{ partNo: "P1", qty: 2, rate: 50 }],
    });
    expect(out.customer).toBe("Summit Automation");
    expect(out.grandTotal).toBe(248500);
  });
});

describe("normalizedToScorable", () => {
  it("lifts po_number/po_date/name and renames qty/rate/part from a raw pipeline extract", () => {
    const out = normalizedToScorable({
      customer: { name: "ACME", po_number: "PO-9", po_date: "2026-07-01" },
      lines: [{ partNumber: "P1", quantity: 3, unitPrice: 20, hsn: "8482" }],
      stated_line_count: 10,
    });
    expect(out).toMatchObject({
      poNumber: "PO-9", poDate: "2026-07-01", customer: "ACME",
      lineItems: [{ partNo: "P1", qty: 3, rate: 20, hsn: "8482" }],
      stated_line_count: 10,
    });
  });

  it("emits grandTotal from a totals object (so a golden with grandTotal doesn't false-fail)", () => {
    expect(normalizedToScorable({ customer: {}, lines: [], totals: { grand_total: 248500 } }).grandTotal).toBe(248500);
    // no totals -> no grandTotal key (scoreCase then skips the check)
    expect(normalizedToScorable({ customer: {}, lines: [] })).not.toHaveProperty("grandTotal");
  });
});

describe("scoreCase precision + non-reuse matching (P4)", () => {
  const expected = {
    poNumber: "PO-1",
    lineItems: [{ partNo: "A", qty: 1, rate: 10 }, { partNo: "B", qty: 2, rate: 20 }],
  };

  it("scores a perfect match with no precision penalty", () => {
    const out = scoreCase(expected, { poNumber: "PO-1", lineItems: [{ partNo: "A", qty: 1, rate: 10 }, { partNo: "B", qty: 2, rate: 20 }] });
    expect(out.fail).toBe(0);
    expect(out.checks.find((c) => c.name === "line_precision").ok).toBe(true);
  });

  it("penalises extra/hallucinated actual lines via line_precision", () => {
    const out = scoreCase(expected, {
      poNumber: "PO-1",
      lineItems: [{ partNo: "A", qty: 1, rate: 10 }, { partNo: "B", qty: 2, rate: 20 }, { partNo: "C", qty: 9, rate: 9 }],
    });
    const prec = out.checks.find((c) => c.name === "line_precision");
    expect(prec.ok).toBe(false);                 // one extra line
    expect(out.checks.find((c) => c.name === "lineItemCount").ok).toBe(false);
  });

  it("does not let one actual line satisfy two expected lines (no reuse)", () => {
    // Two expected lines both named 'A'; only ONE actual 'A'. The second must
    // go unmatched (recall miss), not reuse the first.
    const exp = { lineItems: [{ partNo: "A" }, { partNo: "A" }] };
    const out = scoreCase(exp, { lineItems: [{ partNo: "A" }] });
    const lineChecks = out.checks.filter((c) => /^line\[\d+\]\.partNo$/.test(c.name));
    expect(lineChecks.filter((c) => c.ok).length).toBe(1);   // exactly one matched
    expect(lineChecks.filter((c) => !c.ok).length).toBe(1);  // the second is a miss
  });

  it("flags the 6-of-190 shortfall as a massive recall failure", () => {
    const exp = { lineItems: new Array(190).fill(0).map((_, i) => ({ partNo: "P" + i })) };
    const act = { lineItems: new Array(6).fill(0).map((_, i) => ({ partNo: "P" + i })) };
    const out = scoreCase(exp, act);
    const missed = out.checks.filter((c) => /^line\[\d+\]\.partNo$/.test(c.name) && !c.ok).length;
    expect(missed).toBe(184);
    expect(out.score).toBeLessThan(0.1);
  });
});
