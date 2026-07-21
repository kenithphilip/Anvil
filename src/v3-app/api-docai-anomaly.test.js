// Unit tests for src/api/_lib/docai/anomaly.js (Wave 3.1).

import { describe, it, expect } from "vitest";
import { detectAnomalies, checkLine, __test } from "../api/_lib/docai/anomaly.js";

describe("__test.lineArithmetic", () => {
  it("returns null when qty * unitPrice ≈ amount", () => {
    expect(__test.lineArithmetic({ quantity: 10, unitPrice: 100, amount: 1000 })).toBeNull();
  });
  it("flags a 10x off-by-decimal", () => {
    const out = __test.lineArithmetic({ quantity: 10, unitPrice: 100, amount: 10000 });
    expect(out).not.toBeNull();
    expect(out.code).toBe("line_arithmetic_mismatch");
    expect(out.detail).toContain("off by 10x");
  });
  it("applies discount_pct to expected", () => {
    expect(__test.lineArithmetic({ quantity: 10, unitPrice: 100, discount_pct: 10, amount: 900 })).toBeNull();
  });
  it("returns null when amount is missing", () => {
    expect(__test.lineArithmetic({ quantity: 10, unitPrice: 100 })).toBeNull();
  });
});

describe("__test.linePriceSanity", () => {
  it("flags negative prices as error", () => {
    expect(__test.linePriceSanity({ unitPrice: -5 }, {}).severity).toBe("error");
  });
  it("flags zero prices as warn", () => {
    expect(__test.linePriceSanity({ unitPrice: 0 }, {}).code).toBe("unit_price_zero");
  });
  it("flags implausibly high", () => {
    const out = __test.linePriceSanity({ unitPrice: 100_000_000 }, {});
    expect(out.code).toBe("unit_price_implausibly_high");
  });
  it("respects opts.maxUnitPrice", () => {
    const out = __test.linePriceSanity({ unitPrice: 50_000 }, { maxUnitPrice: 1000 });
    expect(out.code).toBe("unit_price_implausibly_high");
  });
});

describe("__test.lineQtySanity", () => {
  it("flags fractional integer-uom quantities", () => {
    expect(__test.lineQtySanity({ quantity: 1.5, uom: "NOS" }).code).toBe("quantity_fractional_for_unit_uom");
  });
  it("allows fractional for KG", () => {
    expect(__test.lineQtySanity({ quantity: 1.5, uom: "KG" })).toBeNull();
  });
  it("flags negative", () => {
    expect(__test.lineQtySanity({ quantity: -1 }).severity).toBe("error");
  });
});

describe("__test.lineHsnSanity", () => {
  it("flags non-numeric HSN", () => {
    expect(__test.lineHsnSanity({ hsn: "ABCD" }).code).toBe("hsn_malformed");
  });
  it("flags too-short HSN", () => {
    expect(__test.lineHsnSanity({ hsn: "12" }).code).toBe("hsn_malformed");
  });
  it("passes a valid HSN", () => {
    expect(__test.lineHsnSanity({ hsn: "8482" })).toBeNull();
    expect(__test.lineHsnSanity({ hsn: "84823091" })).toBeNull();
  });
});

describe("__test.lineGstSanity", () => {
  it("flags out-of-range", () => {
    expect(__test.lineGstSanity({ gst_pct: 150 }).severity).toBe("error");
    expect(__test.lineGstSanity({ gst_pct: -1 }).severity).toBe("error");
  });
  it("flags non-standard slabs as info", () => {
    const out = __test.lineGstSanity({ gst_pct: 7 });
    expect(out.severity).toBe("info");
  });
  it("passes standard slabs", () => {
    for (const slab of [0, 0.1, 0.25, 3, 5, 12, 18, 28]) {
      expect(__test.lineGstSanity({ gst_pct: slab })).toBeNull();
    }
  });
});

describe("checkLine integration", () => {
  it("returns multiple issues per line when applicable", () => {
    const issues = checkLine({ quantity: -5, unitPrice: -10, gst_pct: 7, hsn: "ABCD" }, 2, {});
    expect(issues.length).toBeGreaterThan(2);
    expect(issues.every((x) => x.line_index === 2)).toBe(true);
  });
  it("returns [] for a clean line", () => {
    expect(checkLine({ quantity: 10, unitPrice: 100, amount: 1000, gst_pct: 18, hsn: "8482" }, 0, {})).toEqual([]);
  });
});

describe("__test.checkLineCountShortfall", () => {
  const run = (normalized, opts) => __test.checkLineCountShortfall(normalized, opts);

  it("flags an error when declared > extracted", () => {
    const out = run({ stated_line_count: 10, lines: new Array(4).fill({}) });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("line_count_shortfall");
    expect(out[0].severity).toBe("error");
    expect(out[0].actual).toBe(4);
    expect(out[0].expected).toBe(10);
  });

  it("no finding when extracted == declared", () => {
    expect(run({ stated_line_count: 4, lines: new Array(4).fill({}) })).toEqual([]);
  });

  it("no finding when the declaration is null / absent", () => {
    expect(run({ lines: new Array(4).fill({}) })).toEqual([]);
    expect(run({ stated_line_count: null, lines: new Array(4).fill({}) })).toEqual([]);
  });

  it("no finding when declared < 2 (empty_lines path owns the 1-and-0 case)", () => {
    expect(run({ stated_line_count: 1, lines: [] })).toEqual([]);
  });

  it("respects a configured slack tolerance", () => {
    // declares 10, extracted 8, slack 2 -> tolerated.
    expect(run({ stated_line_count: 10, lines: new Array(8).fill({}) }, { lineCountShortfallSlack: 2 })).toEqual([]);
    // slack 1 -> still short by 2 -> flagged.
    expect(run({ stated_line_count: 10, lines: new Array(8).fill({}) }, { lineCountShortfallSlack: 1 })).toHaveLength(1);
  });

  it("can be disabled via opts", () => {
    expect(run({ stated_line_count: 100, lines: [] }, { lineCountShortfallEnabled: false })).toEqual([]);
  });

  it("treats a zero-line extraction against a real declaration as a shortfall", () => {
    const out = run({ stated_line_count: 12, lines: [] });
    expect(out).toHaveLength(1);
    expect(out[0].actual).toBe(0);
    expect(out[0].expected).toBe(12);
  });
});

describe("detectAnomalies / header + totals", () => {
  it("flags grand_total_mismatch", () => {
    const out = detectAnomalies({
      customer: {},
      lines: [{ quantity: 10, unitPrice: 100, amount: 1000 }],
      totals: { subtotal: 1000, tax_amount: 180, grand_total: 5000 },
    });
    expect(out.anomalies.some((a) => a.code === "grand_total_mismatch")).toBe(true);
    expect(out.has_blockers).toBe(true);
  });

  it("flags subtotal_does_not_match_lines", () => {
    const out = detectAnomalies({
      customer: {},
      lines: [
        { quantity: 10, unitPrice: 100, amount: 1000 },
        { quantity: 5, unitPrice: 200, amount: 1000 },
      ],
      totals: { subtotal: 5000, tax_amount: 900, grand_total: 5900 },
    });
    expect(out.anomalies.some((a) => a.code === "subtotal_does_not_match_lines")).toBe(true);
  });

  it("flags future PO dates", () => {
    const out = detectAnomalies({
      customer: { po_date: "2099-12-31" },
      lines: [],
    });
    expect(out.anomalies.some((a) => a.code === "po_date_future")).toBe(true);
  });

  it("flags currency_inconsistent_with_lines", () => {
    const out = detectAnomalies({
      customer: { currency: "INR" },
      lines: [{ quantity: 1, unitPrice: 10, amount: 10, currency: "USD" }],
    });
    expect(out.anomalies.some((a) => a.code === "currency_inconsistent_with_lines")).toBe(true);
  });

  it("returns empty on null normalized", () => {
    expect(detectAnomalies(null).anomalies).toEqual([]);
    expect(detectAnomalies(null).has_blockers).toBe(false);
  });

  // CM P3: the line-count completeness gate — the 6-of-190 case.
  it("flags line_count_shortfall as a blocker when extraction is short of the declared count", () => {
    const out = detectAnomalies({
      customer: {},
      stated_line_count: 190,
      lines: new Array(6).fill(0).map((_, i) => ({ partNumber: "P" + i, quantity: 1, unitPrice: 10, amount: 10 })),
    });
    const f = out.anomalies.find((a) => a.code === "line_count_shortfall");
    expect(f).toBeTruthy();
    expect(f.severity).toBe("error");
    expect(f.actual).toBe(6);
    expect(f.expected).toBe(190);
    expect(f.detail).toContain("short by 184");
    expect(out.has_blockers).toBe(true);   // forces the run into review
  });

  it("does not flag when extraction meets or exceeds the declared count", () => {
    const out = detectAnomalies({
      customer: {},
      stated_line_count: 3,
      lines: [{ partNumber: "A" }, { partNumber: "B" }, { partNumber: "C" }],
    });
    expect(out.anomalies.some((a) => a.code === "line_count_shortfall")).toBe(false);
  });

  it("produces an accurate summary", () => {
    const out = detectAnomalies({
      customer: {},
      lines: [
        { quantity: -1, unitPrice: 10, amount: -10 }, // quantity error + amount error
        { quantity: 10, unitPrice: 100, amount: 999_999 }, // arithmetic mismatch
      ],
    });
    expect(out.summary.total).toBe(out.anomalies.length);
    expect(out.summary.error).toBeGreaterThanOrEqual(1);
  });
});
