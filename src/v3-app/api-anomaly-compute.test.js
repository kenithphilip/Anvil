// Unit tests for the anomaly rule library.
//
// Tests run against the exposed `__test` helpers (RULES, computeMargin, etc.)
// rather than the HTTP handler so they don't need a Supabase client. Each
// test builds a minimal `ctx` and asserts which flag keys do or don't fire.

import { describe, it, expect } from "vitest";
import { __test } from "../api/anomaly/compute.js";

const { RULES, computeMargin, gcdAll, parseDays, median, mad, robustZ } = __test;

const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

const baseCtx = (overrides = {}) => ({
  candidate: { lineItems: [] },
  customer: {},
  supplierState: null,
  totals: [],
  lineCounts: [],
  partRates: {},
  partUomByKey: {},
  qtyHistByPart: {},
  crossPartRates: {},
  marginPctHistory: [],
  leadTimeDays: [],
  freightShares: [],
  aliasConfByText: {},
  aliasAmbiguity: {},
  openARTotal: null,
  priceComposition: null,
  ...overrides,
});

const fire = (id, ctx) => {
  const r = RULE_BY_ID[id];
  if (!r) throw new Error("no rule " + id);
  if (r.applies && !r.applies(ctx)) return [];
  return r.evaluate(ctx);
};

describe("anomaly helpers", () => {
  it("median / mad / robustZ", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(mad([1, 1, 1, 1, 5])).toBe(0);
    const z = robustZ(100, [10, 11, 9, 12, 10]);
    expect(z).toBeGreaterThan(2);
  });
  it("gcdAll", () => {
    expect(gcdAll([10, 20, 30, 40, 50])).toBe(10);
    expect(gcdAll([7, 14, 21])).toBe(7);
    expect(gcdAll([])).toBe(0);
  });
  it("parseDays", () => {
    expect(parseDays("30 days")).toBe(30);
    expect(parseDays("Net 60")).toBe(60);
    expect(parseDays(null)).toBeNull();
  });
  it("computeMargin", () => {
    const so = { lineItems: [{ tallyItemName: "P1", qty: 10, rate: 100 }] };
    const pc = { lineItems: [{ partNumber: "P1", landedCostINR: 70 }] };
    const m = computeMargin(so, pc);
    expect(m.selling).toBe(1000);
    expect(m.landed).toBe(700);
    expect(m.marginPct).toBeCloseTo(30, 5);
  });
});

describe("rule library has 18+ rules", () => {
  it("exposes the design's rule count", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(18);
  });
  it("every rule has id + label + evaluate", () => {
    for (const r of RULES) {
      expect(r.id).toBeTruthy();
      expect(r.label).toBeTruthy();
      expect(typeof r.evaluate).toBe("function");
    }
  });
});

describe("rule: grand_total", () => {
  it("fires when candidate is far from history", () => {
    const out = fire("grand_total", baseCtx({
      candidate: { grandTotal: 1500000, lineItems: [] },
      totals: [100000, 105000, 98000, 102000, 101000],
    }));
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("high");
  });
  it("does not fire within MAD", () => {
    const out = fire("grand_total", baseCtx({
      candidate: { grandTotal: 102000, lineItems: [] },
      totals: [100000, 105000, 98000, 102000, 101000],
    }));
    expect(out.length).toBe(0);
  });
  it("does not fire when sample too small", () => {
    const out = fire("grand_total", baseCtx({
      candidate: { grandTotal: 100, lineItems: [] },
      totals: [10, 12], // <3
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: rate_10x_jump", () => {
  it("fires on a >=10x rate jump (UoM unchanged)", () => {
    const out = fire("rate_10x_jump", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "BR-1", uom: "PCS", rate: 9000 }] },
      partRates: { "BR-1": [800, 820, 790, 810] },
      partUomByKey: { "BR-1": "PCS" },
    }));
    expect(out.length).toBe(1);
    expect(out[0].key).toBe("rate_10x_jump");
    expect(out[0].severity).toBe("high");
  });
  it("does not fire when UOM changed (legit denomination flip)", () => {
    const out = fire("rate_10x_jump", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "BR-1", uom: "SET", rate: 9000 }] },
      partRates: { "BR-1": [800, 820, 790, 810] },
      partUomByKey: { "BR-1": "PCS" },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: cross_customer_rate_drift", () => {
  it("fires when this-customer history is small and tenant median diverges", () => {
    const out = fire("cross_customer_rate_drift", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", rate: 400 }] },
      partRates: { "P1": [] },
      crossPartRates: { "P1": [1000, 1050, 950, 1020, 990, 1010] },
    }));
    expect(out.length).toBe(1);
    expect(out[0].key).toBe("cross_customer_rate_drift");
  });
  it("does not fire when this-customer has its own history", () => {
    const out = fire("cross_customer_rate_drift", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", rate: 400 }] },
      partRates: { "P1": [400, 410, 395, 405, 408] },
      crossPartRates: { "P1": [1000, 1050, 950, 1020, 990, 1010] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: rate_below_landed_cost", () => {
  it("fires when rate is below landed cost", () => {
    const out = fire("rate_below_landed_cost", baseCtx({
      candidate: {
        lineItems: [{ sellerPartNo: "P1", rate: 450 }],
      },
      priceComposition: { lineItems: [{ partNumber: "P1", landedCostINR: 500 }] },
    }));
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("high");
  });
  it("does not fire when rate is healthy", () => {
    const out = fire("rate_below_landed_cost", baseCtx({
      candidate: {
        lineItems: [{ sellerPartNo: "P1", rate: 600 }],
      },
      priceComposition: { lineItems: [{ partNumber: "P1", landedCostINR: 500 }] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: round_number_rate", () => {
  it("fires on round number when history is varied", () => {
    // History with mad/median > 2% so the variance gate passes.
    const out = fire("round_number_rate", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", rate: 50000 }] },
      partRates: { "P1": [40000, 55000, 42000, 56000, 43000, 57000] },
    }));
    expect(out[0]?.key).toBe("round_number_rate");
  });
  it("does not fire when history is itself round", () => {
    const out = fire("round_number_rate", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", rate: 50000 }] },
      partRates: { "P1": [50000, 50000, 50000, 50000, 50000] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: margin_floor_breach", () => {
  it("fires when margin is below 8%", () => {
    const out = fire("margin_floor_breach", baseCtx({
      candidate: { lineItems: [{ sellerPartNo: "P1", qty: 10, rate: 100 }] },
      priceComposition: { lineItems: [{ partNumber: "P1", landedCostINR: 95 }] },
    }));
    expect(out[0]?.key).toBe("margin_floor_breach");
  });
  it("does not fire when margin healthy", () => {
    const out = fire("margin_floor_breach", baseCtx({
      candidate: { lineItems: [{ sellerPartNo: "P1", qty: 10, rate: 100 }] },
      priceComposition: { lineItems: [{ partNumber: "P1", landedCostINR: 80 }] },
    }));
    expect(out.length).toBe(0);
  });
  it("fires high severity when margin negative", () => {
    const out = fire("margin_floor_breach", baseCtx({
      candidate: { lineItems: [{ sellerPartNo: "P1", qty: 10, rate: 100 }] },
      priceComposition: { lineItems: [{ partNumber: "P1", landedCostINR: 110 }] },
    }));
    expect(out[0]?.severity).toBe("high");
  });
});

describe("rule: gst_rate_inconsistent_for_hsn", () => {
  it("fires when same HSN has multiple GST rates", () => {
    const out = fire("gst_rate_inconsistent_for_hsn", baseCtx({
      candidate: { lineItems: [
        { hsnCode: "8481", gstPct: 18 },
        { hsnCode: "8481", gstPct: 28 },
      ] },
    }));
    expect(out.length).toBe(1);
    expect(out[0].detail).toContain("18");
    expect(out[0].detail).toContain("28");
  });
  it("does not fire when both lines agree", () => {
    const out = fire("gst_rate_inconsistent_for_hsn", baseCtx({
      candidate: { lineItems: [
        { hsnCode: "8481", gstPct: 18 },
        { hsnCode: "8481", gstPct: 18 },
      ] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: missing_hsn_or_gst", () => {
  it("fires per line missing HSN", () => {
    const out = fire("missing_hsn_or_gst", baseCtx({
      candidate: { lineItems: [
        { hsnCode: null, gstPct: 18 },
        { hsnCode: "8481", gstPct: null },
      ] },
    }));
    expect(out.length).toBe(2);
  });
  it("does not fire when both fields present", () => {
    const out = fire("missing_hsn_or_gst", baseCtx({
      candidate: { lineItems: [{ hsnCode: "8481", gstPct: 18 }] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: gst_class_mismatch", () => {
  it("fires when expected IGST but candidate is CGST_SGST", () => {
    const out = fire("gst_class_mismatch", baseCtx({
      candidate: { gstMode: "CGST_SGST", lineItems: [] },
      customer: { state_code: "KA" },
      supplierState: "MH",
    }));
    expect(out.length).toBe(1);
    expect(out[0].key).toBe("gst_class_mismatch");
  });
  it("does not fire when intra-state with CGST_SGST", () => {
    const out = fire("gst_class_mismatch", baseCtx({
      candidate: { gstMode: "CGST_SGST", lineItems: [] },
      customer: { state_code: "MH" },
      supplierState: "MH",
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: payment_terms_drift", () => {
  it("fires when terms drift more than 30 days", () => {
    const out = fire("payment_terms_drift", baseCtx({
      candidate: { paymentTerms: "Net 90", lineItems: [] },
      customer: { default_payment_terms: "Net 30" },
    }));
    expect(out.length).toBe(1);
  });
  it("does not fire when terms within 30 days", () => {
    const out = fire("payment_terms_drift", baseCtx({
      candidate: { paymentTerms: "Net 45", lineItems: [] },
      customer: { default_payment_terms: "Net 30" },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: credit_overrun", () => {
  it("fires high when limit on file is exceeded", () => {
    const out = fire("credit_overrun", baseCtx({
      candidate: { grandTotal: 500000, lineItems: [] },
      customer: { credit_limit: 1000000 },
      openARTotal: 800000,
      totals: [200000],
    }));
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("high");
  });
  it("fires low when no limit on file but synthetic ceiling exceeded", () => {
    const out = fire("credit_overrun", baseCtx({
      candidate: { grandTotal: 500000, lineItems: [] },
      customer: {},
      openARTotal: 2500000,
      totals: [1000000],
    }));
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("low");
  });
  it("does not fire when projection well below ceiling", () => {
    const out = fire("credit_overrun", baseCtx({
      candidate: { grandTotal: 100000, lineItems: [] },
      customer: { credit_limit: 5000000 },
      openARTotal: 200000,
      totals: [1000000],
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: alias_low_confidence", () => {
  it("fires when alias confidence is below 0.7", () => {
    const out = fire("alias_low_confidence", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "BRG-SKF-6204" }] },
      aliasConfByText: { "BRG-SKF-6204": 0.45 },
    }));
    expect(out[0]?.severity).toBe("medium");
  });
  it("does not fire on confident aliases", () => {
    const out = fire("alias_low_confidence", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "BRG-SKF-6204" }] },
      aliasConfByText: { "BRG-SKF-6204": 0.92 },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: ambiguous_alias", () => {
  it("fires when same alias maps to >=2 part numbers", () => {
    const out = fire("ambiguous_alias", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "GASKET 4MM" }] },
      aliasAmbiguity: { "GASKET 4MM": 2 },
    }));
    expect(out[0]?.key).toBe("ambiguous_alias");
  });
  it("does not fire on unique aliases", () => {
    const out = fire("ambiguous_alias", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "GASKET 4MM" }] },
      aliasAmbiguity: { "GASKET 4MM": 1 },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: duplicate_line", () => {
  it("fires when two lines match part+uom+rate", () => {
    const out = fire("duplicate_line", baseCtx({
      candidate: { lineItems: [
        { tallyItemName: "BRG-1", uom: "PCS", rate: 420 },
        { tallyItemName: "BRG-1", uom: "PCS", rate: 420 },
      ] },
    }));
    expect(out.length).toBe(1);
    expect(out[0].lineIndex).toBe(1);
  });
  it("does not fire when rates differ", () => {
    const out = fire("duplicate_line", baseCtx({
      candidate: { lineItems: [
        { tallyItemName: "BRG-1", uom: "PCS", rate: 420 },
        { tallyItemName: "BRG-1", uom: "PCS", rate: 450 },
      ] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: qty_step_skip", () => {
  it("fires when qty is not a multiple of inferred pack size", () => {
    const out = fire("qty_step_skip", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", qty: 7 }] },
      qtyHistByPart: { "P1": [10, 20, 30, 40, 50] },
    }));
    expect(out[0]?.key).toBe("qty_step_skip");
  });
  it("does not fire when qty matches pack size", () => {
    const out = fire("qty_step_skip", baseCtx({
      candidate: { lineItems: [{ tallyItemName: "P1", qty: 30 }] },
      qtyHistByPart: { "P1": [10, 20, 30, 40, 50] },
    }));
    expect(out.length).toBe(0);
  });
});

describe("rule: lead_time_spike", () => {
  it("fires when lead time is well below the historical median", () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString();
    const out = fire("lead_time_spike", baseCtx({
      candidate: { expectedDelivery: tomorrow, lineItems: [] },
      leadTimeDays: [14, 16, 12, 15, 13, 14, 14],
    }));
    expect(out[0]?.key).toBe("lead_time_spike");
  });
  it("does not fire when lead time is normal", () => {
    const future = new Date(Date.now() + 14 * 86400000).toISOString();
    const out = fire("lead_time_spike", baseCtx({
      candidate: { expectedDelivery: future, lineItems: [] },
      leadTimeDays: [14, 16, 12, 15, 13, 14, 14],
    }));
    expect(out.length).toBe(0);
  });
});
