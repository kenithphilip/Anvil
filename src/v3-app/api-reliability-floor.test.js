// Step 4b: the reliability safety-stock floor (pure math) + its integration into
// safetyStock()'s max(). Verifies the floor is zero without a failure signal /
// lead time (so it is inert for parts with no failures), scales as
// z(alpha)*sqrt(lambda*leadTimeWeeks), and only raises SS when it exceeds the
// statistical + project candidates (non-double-counting via max).

import { describe, it, expect } from "vitest";
import { reliabilityFloor, weeklyFailureRate } from "../api/_lib/inventory/reliability.js";
import { safetyStock, standardNormalInverse } from "../api/_lib/inventory/safety-stock.js";

describe("weeklyFailureRate", () => {
  it("is totalReplacedQty / windowWeeks", () => {
    expect(weeklyFailureRate({ totalReplacedQty: 104, windowWeeks: 104 })).toBe(1);
    expect(weeklyFailureRate({ totalReplacedQty: 52, windowWeeks: 104 })).toBe(0.5);
  });
  it("is 0 for no failures, zero/negative window, or non-finite qty", () => {
    expect(weeklyFailureRate({ totalReplacedQty: 0, windowWeeks: 104 })).toBe(0);
    expect(weeklyFailureRate({ totalReplacedQty: 10, windowWeeks: 0 })).toBe(0);
    expect(weeklyFailureRate({ totalReplacedQty: NaN, windowWeeks: 104 })).toBe(0);
  });
});

describe("reliabilityFloor", () => {
  it("is z(alpha) * sqrt(lambda * leadTimeWeeks)", () => {
    // lambda = 104/104 = 1; leadTimeWeeks = 4 -> exp = 4 -> sqrt = 2.
    const expected = standardNormalInverse(0.95) * 2;
    const got = reliabilityFloor({ totalReplacedQty: 104, windowWeeks: 104, leadTimeWeeks: 4, alpha: 0.95 });
    expect(got).toBeCloseTo(expected, 6);
    expect(got).toBeGreaterThan(0);
  });
  it("is 0 when there is no failure signal or no lead time", () => {
    expect(reliabilityFloor({ totalReplacedQty: 0, windowWeeks: 104, leadTimeWeeks: 4, alpha: 0.95 })).toBe(0);
    expect(reliabilityFloor({ totalReplacedQty: 104, windowWeeks: 104, leadTimeWeeks: 0, alpha: 0.95 })).toBe(0);
  });
  it("rises with service level (alpha)", () => {
    const lo = reliabilityFloor({ totalReplacedQty: 104, windowWeeks: 104, leadTimeWeeks: 4, alpha: 0.85 });
    const hi = reliabilityFloor({ totalReplacedQty: 104, windowWeeks: 104, leadTimeWeeks: 4, alpha: 0.99 });
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("safetyStock reliabilityFloor integration", () => {
  const base = {
    alpha: 0.95, demandMean: 0.1, demandSigma: 0.1,
    leadTimeMean: 2, leadTimeSigma: 0.5, demandClass: "intermittent",
    avg4w: 0, projectEquivalentQty: 0,
  };
  it("defaults to 0 (no reliabilityFloor arg) -> SS unchanged", () => {
    const without = safetyStock(base);
    const withZero = safetyStock({ ...base, reliabilityFloor: 0 });
    expect(withZero.ss).toBe(without.ss);
    expect(withZero.breakdown.reliability_floor).toBe(0);
  });
  it("raises SS to the floor only when it exceeds the other candidates", () => {
    const without = safetyStock(base);
    const big = without.ss + 100;
    const withFloor = safetyStock({ ...base, reliabilityFloor: big });
    expect(withFloor.ss).toBe(big);                       // floor wins the max()
    expect(withFloor.breakdown.reliability_floor).toBe(big);
  });
  it("does NOT stack: a small floor below statSS leaves SS unchanged", () => {
    const without = safetyStock(base);
    const withSmall = safetyStock({ ...base, reliabilityFloor: Math.max(0, without.ss - 0.001) });
    expect(withSmall.ss).toBe(without.ss);               // max(), not sum
  });
});
