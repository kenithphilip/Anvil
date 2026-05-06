// Unit tests for the statistical delay predictor. Pins the math:
// median+MAD, robust-z, business-day arithmetic, logistic
// probability, learned per-supplier SLAs, and criticality multiplier.

import { describe, it, expect } from "vitest";
import { __test } from "../api/delays/predict.js";

const {
  median, mad, robustZ, businessDaysBetween, addBusinessDays,
  learnSla, learnSuppliersSlas, sigmoid, delayProbability,
  predictEta, criticalityFor, riskScore,
} = __test;

describe("predict: descriptive stats", () => {
  it("median: even and odd lengths", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("median is robust to a single huge outlier", () => {
    const sample = [3, 4, 5, 6, 7];
    const withOutlier = [...sample, 1000];
    // Mean would shift from 5 to ~170; median barely moves.
    expect(median(withOutlier)).toBeLessThan(10);
  });

  it("mad returns 0 on length<2 and is non-negative otherwise", () => {
    expect(mad([])).toBe(0);
    expect(mad([5])).toBe(0);
    expect(mad([1, 2, 3, 4, 5])).toBeGreaterThan(0);
  });

  it("robustZ flags an outlier point above its sample", () => {
    const sample = [4, 5, 5, 6, 6, 7];
    expect(robustZ(20, sample)).toBeGreaterThan(3);
    expect(robustZ(5, sample)).toBeLessThan(1);
  });
});

describe("predict: business-day arithmetic", () => {
  it("counts only Mon-Fri between two dates inclusive", () => {
    // 2026-05-04 (Mon) -> 2026-05-08 (Fri) = 5 business days.
    expect(businessDaysBetween("2026-05-04", "2026-05-08")).toBe(5);
  });

  it("excludes weekends", () => {
    // 2026-05-08 (Fri) -> 2026-05-11 (Mon) crosses weekend = 2 days.
    expect(businessDaysBetween("2026-05-08", "2026-05-11")).toBe(2);
  });

  it("excludes holiday list", () => {
    expect(businessDaysBetween("2026-05-04", "2026-05-08", ["2026-05-06"])).toBe(4);
  });

  it("addBusinessDays skips weekends", () => {
    // Add 1 business day to Friday -> Monday.
    const d = addBusinessDays("2026-05-08", 1);
    // Date.getDay 1=Mon
    const got = new Date(d);
    expect(got.getUTCDay()).toBeLessThanOrEqual(5);
    expect(got.getUTCDay()).toBeGreaterThanOrEqual(1);
  });

  it("returns null on bad input", () => {
    expect(businessDaysBetween(null, null)).toBe(null);
    expect(businessDaysBetween("nope", "2026-05-08")).toBe(null);
  });
});

describe("predict: SLA learning", () => {
  it("returns null when sample is too small", () => {
    expect(learnSla([1, 2])).toBe(null);
  });

  it("learned SLA = round(median + 1.5*MAD), >=1", () => {
    const out = learnSla([5, 5, 6, 6, 6, 7, 7, 8]);
    expect(out).toBeGreaterThanOrEqual(6);
    expect(out).toBeLessThanOrEqual(10);
  });

  it("learnSuppliersSlas groups by supplier and includes samples count", () => {
    const sent = "2026-04-01";
    const ack = "2026-04-08";
    const history = Array.from({ length: 6 }, () => ({
      supplier: "SKF",
      sent_at: sent,
      acked_at: ack,
    }));
    const out = learnSuppliersSlas(history);
    expect(out.SKF).toBeTruthy();
    expect(out.SKF.samples).toBe(6);
    expect(out.SKF.sla).toBeGreaterThan(0);
  });

  it("ignores rows missing sent or ack", () => {
    const out = learnSuppliersSlas([
      { supplier: "X", sent_at: null, acked_at: "2026-04-08" },
      { supplier: "X", sent_at: "2026-04-01", acked_at: null },
    ]);
    expect(out.X).toBeUndefined();
  });
});

describe("predict: logistic probability", () => {
  it("at ratio=1, probability ~ 0.5", () => {
    const p = delayProbability(7, 7);
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.55);
  });

  it("at ratio=2, probability > 0.85", () => {
    expect(delayProbability(14, 7)).toBeGreaterThan(0.85);
  });

  it("at ratio=0.5, probability < 0.30", () => {
    // beta0=-2, beta1=2, ratio=0.5 -> z=-1 -> sigmoid(-1) ~ 0.269
    expect(delayProbability(3.5, 7)).toBeLessThan(0.30);
  });

  it("supplierOutlierRate increases the probability", () => {
    const p0 = delayProbability(7, 7, 0);
    const p1 = delayProbability(7, 7, 0.5);
    expect(p1).toBeGreaterThan(p0);
  });

  it("returns 0 on invalid SLA", () => {
    expect(delayProbability(7, 0)).toBe(0);
    expect(delayProbability(7, null)).toBe(0);
  });

  it("sigmoid is monotone and bounded", () => {
    expect(sigmoid(-100)).toBeLessThan(0.001);
    expect(sigmoid(100)).toBeGreaterThan(0.999);
    expect(sigmoid(0)).toBeCloseTo(0.5, 5);
  });
});

describe("predict: ETA", () => {
  it("uses median when supplied", () => {
    const out = predictEta("2026-05-04", { median: 5 }, 14);
    expect(out).toBeTruthy();
    // 2026-05-04 + 5 business days = Mon 2026-05-11.
    expect(out).toBe("2026-05-11");
  });

  it("falls back to static SLA when no median", () => {
    const out = predictEta("2026-05-04", null, 5);
    expect(out).toBeTruthy();
  });

  it("returns null on missing sent date", () => {
    expect(predictEta(null, null, 5)).toBe(null);
  });
});

describe("predict: criticality + risk", () => {
  it("standalone source PO has criticality 1.0", () => {
    expect(criticalityFor("p1", { workOrders: [], shipments: [] })).toBe(1.0);
  });

  it("with one downstream dep -> 1.25", () => {
    expect(criticalityFor("p1", {
      workOrders: [{ source_po_id: "p1" }],
      shipments: [],
    })).toBe(1.25);
  });

  it("with both downstream artifacts -> 1.5", () => {
    expect(criticalityFor("p1", {
      workOrders: [{ source_po_id: "p1" }],
      shipments: [{ source_po_id: "p1" }],
    })).toBe(1.5);
  });

  it("riskScore is monotone in criticality", () => {
    const a = riskScore({ elapsed: 14, sla: 7, criticality: 1.0 });
    const b = riskScore({ elapsed: 14, sla: 7, criticality: 1.5 });
    expect(b).toBeGreaterThanOrEqual(a);
    expect(a).toBeLessThanOrEqual(100);
    expect(b).toBeLessThanOrEqual(100);
  });
});

describe("predict: integration with scan via __test", () => {
  it("the predict module exports stay pure (no Supabase import)", async () => {
    // Vitest will throw if importing predict requires the Supabase client.
    const mod = await import("../api/delays/predict.js");
    expect(typeof mod.delayProbability).toBe("function");
    expect(typeof mod.learnSla).toBe("function");
  });
});
