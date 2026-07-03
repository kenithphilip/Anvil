import { describe, it, expect } from "vitest";
import { computeLineTotals } from "./line-totals";

describe("computeLineTotals", () => {
  it("Path 1: explicit per-unit tax components from a Meridian PO line", () => {
    // PO line 1 (GUIDE ASSY): Ex-Price 46991 per unit, CGST 4229.19,
    // SGST 4229.19. Unit Price = 55449.38 (tax-inclusive),
    // qty 2 -> TotAmt 110,898.76.
    const t = computeLineTotals({
      qty: 2,
      rate: 46991,            // ex-price
      cgst_amount: 4229.19,
      sgst_amount: 4229.19,
    });
    expect(t.source).toBe("explicit");
    expect(t.taxable).toBe(93982);
    expect(t.tax).toBe(16916.76);
    expect(t.aux).toBe(0);
    expect(t.lineTotal).toBe(110898.76);
    expect(t.components.cgst_amount).toBe(4229.19);
    expect(t.components.sgst_amount).toBe(4229.19);
  });

  it("Path 1: rolls auxiliary costs (tooling + P&F + others) into line total", () => {
    const t = computeLineTotals({
      qty: 1,
      rate: 1000,
      cgst_amount: 90,
      sgst_amount: 90,
      tooling_amount: 50,
      p_and_f_amount: 20,
      others_amount: 5,
    });
    expect(t.taxable).toBe(1000);
    expect(t.tax).toBe(180);
    expect(t.aux).toBe(75);
    expect(t.lineTotal).toBe(1255);
  });

  it("Path 2: gst_pct legacy path when no explicit components are set", () => {
    const t = computeLineTotals({ qty: 3, rate: 100, gst_pct: 18 });
    expect(t.source).toBe("gst_pct");
    expect(t.taxable).toBe(300);
    expect(t.tax).toBe(54);
    expect(t.lineTotal).toBe(354);
  });

  it("Path 3: lineTotal passthrough when neither components nor pct are set", () => {
    const t = computeLineTotals({ qty: 2, rate: 100, lineTotal: 250 });
    expect(t.source).toBe("lineTotal");
    expect(t.taxable).toBe(200);
    expect(t.tax).toBe(50);
    expect(t.lineTotal).toBe(250);
  });

  it("Path none: no tax info at all returns taxable only", () => {
    const t = computeLineTotals({ qty: 2, rate: 100 });
    expect(t.source).toBe("none");
    expect(t.tax).toBe(0);
    expect(t.lineTotal).toBe(200);
  });

  it("ignores zero-valued components so a default-empty line stays on the gst_pct path", () => {
    const t = computeLineTotals({ qty: 2, rate: 100, gst_pct: 18, cgst_amount: 0, sgst_amount: 0 });
    expect(t.source).toBe("gst_pct");
  });

  it("never returns a negative tax when lineTotal is less than taxable", () => {
    const t = computeLineTotals({ qty: 2, rate: 100, lineTotal: 150 });
    expect(t.tax).toBe(0); // would have been -50 if not clamped
  });

  it("handles missing line gracefully", () => {
    const t = computeLineTotals(null);
    expect(t.qty).toBe(0);
    expect(t.rate).toBe(0);
    expect(t.lineTotal).toBe(0);
  });
});
