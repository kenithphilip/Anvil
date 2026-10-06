// Regression tests for the money-completeness guard in
// src/api/_lib/docai/anomaly.js (CM P0, Aug 2026).
//
// The incident: a real 4-line PO was truncated to ONE line by
// max_tokens, the truncated JSON was repaired into valid JSON, and every
// existing check reported clean — because checkLineCountShortfall reads
// normalized.stated_line_count, which the model emits AFTER the line array and
// which the same truncation had therefore already discarded. The guard and the
// evidence it needed died together.
//
// checkDocumentTotalShortfall reads the document's PRINTED total out of the
// text layer instead, which the extractor does not author. These tests pin the
// real numbers off that document so a regression is obvious.

import { describe, it, expect } from "vitest";
import { detectAnomalies, __test } from "../api/_lib/docai/anomaly.js";

// The four real line items, as printed. Tax amounts on this layout are PER
// UNIT: 34,202 + 3,078.18 + 3,078.18 = 40,358.36 unit price, x2 = 80,716.72.
const LINE_1 = { partNumber: "PN-A-1200", quantity: 2, unitPrice: 34202, cgst_amount: 3078.18, sgst_amount: 3078.18 };
const LINE_2 = { partNumber: "PN-A-900", quantity: 4, unitPrice: 28126, cgst_amount: 2531.34, sgst_amount: 2531.34 };
const LINE_3 = { partNumber: "PN-A-850", quantity: 3, unitPrice: 27342, cgst_amount: 2460.78, sgst_amount: 2460.78 };
const LINE_4 = { partNumber: "PN-A-800", quantity: 5, unitPrice: 25186, cgst_amount: 2266.74, sgst_amount: 2266.74 };

const PRINTED = "Total Amount : INR 458,859.52";

describe("__test.printedDocumentTotal", () => {
  it("reads an Indian-formatted total off the text layer", () => {
    expect(__test.printedDocumentTotal(PRINTED)).toBe(458859.52);
  });
  it("takes the LARGEST labelled figure, so per-section subtotals don't win", () => {
    const t = "Total Amount : INR 80,716.72\nGrand Total : INR 458,859.52";
    expect(__test.printedDocumentTotal(t)).toBe(458859.52);
  });
  it("returns null when nothing is labelled (check must no-op, not guess)", () => {
    expect(__test.printedDocumentTotal("no totals here, just 12,345.67 floating")).toBeNull();
  });

  // The original pattern required a qualifier ("grand total", "total amount")
  // and so missed ordinary phrasings. Measured against a battery of realistic
  // Indian PO labels it covered ~60%; on a miss the guard no-ops silently,
  // which on the last line of defence means a short voucher with no warning.
  // Each of these was a real miss.
  it.each([
    ["PO document text. Total: 99,000.00", 99000],
    ["PO document text. PO Total: 45,000.00", 45000],
    ["PO document text. Net Total : 12,345.00", 12345],
    ["PO document text. Order Total: 8,900.50", 8900.5],
    ["PO document text. Total Order Value: 5,00,000.00", 500000],
    ["PO document text. Gross Total: 3,333.33", 3333.33],
    ["PO document text. Total (INR): 6,666.66", 6666.66],
    ["PO document text. Net Payable: 4,444.44", 4444.44],
    ["PO document text. Total Purchase Order Value 2,25,000.00", 225000],
  ])("reads %s", (text, expected) => {
    expect(__test.printedDocumentTotal(text)).toBeCloseTo(expected, 2);
  });

  // A subtotal is NOT the grand total. Matching it would understate the
  // document and fire false blockers on every PO that prints one.
  it.each([
    "Purchase order document. Sub Total: 2,222.22",
    "Purchase order document. Subtotal: 2,222.22",
    "Purchase order document. Sub-Total: 2,222.22",
  ])("ignores a subtotal: %s", (text) => {
    expect(__test.printedDocumentTotal(text)).toBeNull();
  });

  it("still takes the max, so a section total cannot beat the grand total", () => {
    const t = "Line section.\nTotal: 80,716.72\nGrand Total: 458,859.52";
    expect(__test.printedDocumentTotal(t)).toBe(458859.52);
  });
  it("returns null on absent/short input", () => {
    expect(__test.printedDocumentTotal(null)).toBeNull();
    expect(__test.printedDocumentTotal("")).toBeNull();
  });
});

describe("__test.lineGross", () => {
  it("multiplies per-unit tax by qty (the stacked multi-row layout)", () => {
    expect(__test.lineGross(LINE_1).gross).toBeCloseTo(80716.72, 2);
  });
  it("falls back to gst_pct when no explicit tax amounts were captured", () => {
    const g = __test.lineGross({ quantity: 2, unitPrice: 100, gst_pct: 18 });
    expect(g.gross).toBeCloseTo(236, 2);
    expect(g.taxSeen).toBe(true);
  });
  it("reports taxSeen=false when neither is present", () => {
    expect(__test.lineGross({ quantity: 2, unitPrice: 100 }).taxSeen).toBe(false);
  });
});

describe("__test.checkDocumentTotalShortfall", () => {
  it("THE INCIDENT: 1 of 4 lines against the printed total raises an error", () => {
    const out = __test.checkDocumentTotalShortfall({ lines: [LINE_1] }, { kind: "po", bodyText: PRINTED });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("document_total_shortfall");
    expect(out[0].severity).toBe("error");
    expect(out[0].expected).toBe(458859.52);
    expect(out[0].actual).toBeCloseTo(80716.72, 2);
    expect(out[0].detail).toContain("17.6%");
  });

  it("all four real lines reproduce the printed total exactly -> silent", () => {
    const lines = [LINE_1, LINE_2, LINE_3, LINE_4];
    const sum = lines.reduce((a, l) => a + __test.lineGross(l).gross, 0);
    expect(sum).toBeCloseTo(458859.52, 1);
    expect(__test.checkDocumentTotalShortfall({ lines }, { kind: "po", bodyText: PRINTED })).toEqual([]);
  });

  it("dropping one of four still trips it", () => {
    const out = __test.checkDocumentTotalShortfall(
      { lines: [LINE_1, LINE_2, LINE_3] }, { kind: "po", bodyText: PRINTED });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("error");
  });

  it("no printed total -> no-op (never guesses)", () => {
    expect(__test.checkDocumentTotalShortfall({ lines: [LINE_1] }, { kind: "po", bodyText: "nothing labelled" })).toEqual([]);
  });

  it("no tax captured -> widened ceiling prevents a false blocker", () => {
    // Lines sum to 100000 ex-tax against a tax-inclusive printed 118000.
    // Raw coverage 84.7% would warn; the 1.30x widening clears it.
    const lines = [{ quantity: 1, unitPrice: 100000 }];
    expect(__test.checkDocumentTotalShortfall({ lines }, { kind: "po", bodyText: "Total Amount : 118,000.00" })).toEqual([]);
  });

  it("zero lines -> no-op (the run already fails on empty_lines)", () => {
    expect(__test.checkDocumentTotalShortfall({ lines: [] }, { kind: "po", bodyText: PRINTED })).toEqual([]);
  });

  it("lines with no money -> no-op", () => {
    expect(__test.checkDocumentTotalShortfall(
      { lines: [{ partNumber: "X" }] }, { kind: "po", bodyText: PRINTED })).toEqual([]);
  });

  it("respects the kill switch", () => {
    expect(__test.checkDocumentTotalShortfall(
      { lines: [LINE_1] },
      { kind: "po", bodyText: PRINTED, documentTotalCheckEnabled: false })).toEqual([]);
  });

  it("does not fire on non-po/rfq kinds", () => {
    expect(__test.checkDocumentTotalShortfall(
      { lines: [LINE_1] }, { kind: "assembly_bom", bodyText: PRINTED })).toEqual([]);
  });

  it("a near-miss warns rather than blocks", () => {
    // ~96% coverage: under the 98% warn line, over the 80% error line.
    // Explicit tax so taxSeen=true and the 1.30x no-tax widening stays out of it.
    const out = __test.checkDocumentTotalShortfall(
      { lines: [{ quantity: 1, unitPrice: 440000, cgst_amount: 505 }] },
      { kind: "po", bodyText: PRINTED });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warn");
  });
});

describe("detectAnomalies wiring", () => {
  it("surfaces the shortfall as a BLOCKER so the run cannot look clean", () => {
    const rep = detectAnomalies({ lines: [LINE_1] }, { kind: "po", bodyText: PRINTED });
    expect(rep.has_blockers).toBe(true);
    expect(rep.anomalies.some((a) => a.code === "document_total_shortfall")).toBe(true);
  });

  it("stays clean on the complete extraction", () => {
    const rep = detectAnomalies({ lines: [LINE_1, LINE_2, LINE_3, LINE_4] }, { kind: "po", bodyText: PRINTED });
    expect(rep.anomalies.some((a) => a.code === "document_total_shortfall")).toBe(false);
  });

  it("still clean when no bodyText is supplied at all (back-compat)", () => {
    const rep = detectAnomalies({ lines: [LINE_1] }, { kind: "po" });
    expect(rep.anomalies.some((a) => a.code === "document_total_shortfall")).toBe(false);
  });
});
