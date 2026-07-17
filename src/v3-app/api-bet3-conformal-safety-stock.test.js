// Bet 3 regression tests: conformal-prediction safety stock.
//
// Covers the math module end-to-end:
//
//   1. Primitives: weightedAbsQuantile, sanitizeResiduals
//   2. splitCP: empirical coverage on i.i.d. and heavy-tail series
//      (5000 synthetic trials)
//   3. nexCP: weight-decay correctness + recovery on change-point
//      series
//   4. pooledColdStartCP: pool union when own cohort is sparse
//   5. selectAndComputeCP: routing thresholds (<12 -> cold-start,
//      12-25 -> split, >=26 -> nexcp or split per method pref)
//   6. intervalForForecast: clamping + monotonicity
//   7. safetyStockFromInterval: hi - mean floor at 0
//   8. scaleIntervalToLTD: monotonic scaling + sigma inflation
//   9. empiricalCoverage: diagnostic shape
//
// Source-contract checks for the wiring (cron pulls residuals,
// stamps CP fields on forecasts + plans, diagnostics endpoint
// returns the rollup, client method exists). Migration regression.
//
// Hermetic: no DB, no network. ~80 assertions.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  splitCP, nexCP, pooledColdStartCP, intervalForForecast,
  safetyStockFromInterval, scaleIntervalToLTD, selectAndComputeCP,
  empiricalCoverage, __test as P,
} from "../api/_lib/inventory/conformal.js";

const SRC = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// Mulberry32 PRNG so tests are deterministic across runs.
const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Box-Muller for standard-normal draws.
const randn = (rand) => {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// -------------------- primitives --------------------------------

describe("Bet 3 - conformal.js primitives", () => {
  it("sanitizeResiduals drops non-finite and non-numeric entries", () => {
    expect(P.sanitizeResiduals([1, 2, NaN, "x", null, undefined, 3])).toEqual([1, 2, 3]);
    expect(P.sanitizeResiduals([])).toEqual([]);
    expect(P.sanitizeResiduals(null)).toEqual([]);
  });

  it("weightedAbsQuantile returns 0 for empty input", () => {
    expect(P.weightedAbsQuantile([], [], 0.95)).toBe(0);
  });

  it("weightedAbsQuantile returns the smallest |r| that crosses the cumulative weight target", () => {
    // residuals [1, -2, 3], equal weights. Sorted by |r|: 1, 2, 3
    // each w = 1/3. target=0.5 -> first crossing at |r|=2.
    expect(P.weightedAbsQuantile([1, -2, 3], [1, 1, 1], 0.5)).toBe(2);
    // target=0.95 -> last bucket |r|=3.
    expect(P.weightedAbsQuantile([1, -2, 3], [1, 1, 1], 0.95)).toBe(3);
  });

  it("weightedAbsQuantile gives newer residuals more pull when weights are skewed", () => {
    // residual 5 has weight 10, the rest weight 1. With target 0.5
    // we should land on |r|=5 because its weight dominates.
    expect(P.weightedAbsQuantile([1, 2, 3, 5], [1, 1, 1, 10], 0.5)).toBe(5);
  });
});

// -------------------- splitCP -----------------------------------

describe("Bet 3 - splitCP empirical coverage", () => {
  it("returns symmetric band {qLo: -q, qHi: q}", () => {
    const r = splitCP([1, -1, 2, -2, 3, -3], 0.9);
    expect(r.qLo).toBeLessThanOrEqual(0);
    expect(r.qHi).toBeGreaterThanOrEqual(0);
    expect(Math.abs(r.qLo)).toBeCloseTo(r.qHi, 6);
    expect(r.method).toBe("split_cp");
  });

  it("zero residuals -> band collapses to zero", () => {
    const r = splitCP([0, 0, 0, 0, 0], 0.95);
    expect(r.qHi).toBe(0);
    // -0 vs +0: JS treats them as different under Object.is but
    // equal under ===. We accept either.
    expect(Math.abs(r.qLo)).toBe(0);
  });

  it("achieves close-to-nominal coverage on i.i.d. normal residuals (5000 trials)", () => {
    // Calibration: 60 standard-normal residuals. Test: 1 fresh draw.
    // Repeat 5000 times; assert empirical coverage within +/-3 pp of
    // the 0.9 target.
    const rand = rng(0xdeadbeef);
    const N_CALIB = 60;
    const TRIALS = 5000;
    let inside = 0;
    for (let t = 0; t < TRIALS; t++) {
      const calib = Array.from({ length: N_CALIB }, () => randn(rand));
      const fresh = randn(rand);
      const r = splitCP(calib, 0.9);
      if (Math.abs(fresh) <= r.qHi) inside += 1;
    }
    const cov = inside / TRIALS;
    expect(cov).toBeGreaterThan(0.87);
    expect(cov).toBeLessThan(0.94);
  });
});

// -------------------- nexCP -------------------------------------

describe("Bet 3 - nexCP weight-decay correctness", () => {
  it("decays weight monotonically by rho^(n-1-i)", () => {
    const r = nexCP([1, 2, 3, 4, 5], 0.9, 0.5);
    // weights: 0.5^4, 0.5^3, 0.5^2, 0.5^1, 0.5^0 = 0.0625, 0.125, 0.25, 0.5, 1.0
    const expectedWeightSum = 0.0625 + 0.125 + 0.25 + 0.5 + 1.0;
    expect(r.effective_weight_sum).toBeCloseTo(expectedWeightSum, 5);
  });

  it("matches Split CP when rho = 1.0 (no decay)", () => {
    const series = [1, -2, 3, -4, 2.5, -1.5, 4, -3, 2];
    const split = splitCP(series, 0.9);
    const nex = nexCP(series, 0.9, 1.0);
    // Both should converge to the same |residual| because all
    // weights are equal at rho=1.
    expect(nex.qHi).toBeCloseTo(split.qHi, 3);
  });

  it("recovers fast after a change point (recent residuals weighted heavier)", () => {
    // First 30 residuals: small scale (sigma=1). Next 10: large
    // scale (sigma=10). NEXCP with rho=0.9 should track the larger
    // recent residuals.
    const rand = rng(42);
    const small = Array.from({ length: 30 }, () => randn(rand) * 1);
    const large = Array.from({ length: 10 }, () => randn(rand) * 10);
    const r = nexCP([...small, ...large], 0.9, 0.9);
    // Bound should reflect the recent regime, not the pooled
    // average of both. The pooled |r| 90th percentile would be
    // dominated by `small`; the recency-weighted one should be
    // closer to the `large`-scale quantile.
    expect(r.qHi).toBeGreaterThan(4);
  });
});

// -------------------- cold-start --------------------------------

describe("Bet 3 - pooledColdStartCP", () => {
  it("pools across cohorts when the named class is sparse", () => {
    const cohort = {
      ATD: [1, -1],                    // < 12 -> needs pool
      GUN: [2, -2, 3, -3, 4, -4, 5, -5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5],
      SPARE: [0.5, -0.5, 1.2, -1.2],
    };
    const r = pooledColdStartCP(cohort, "ATD", 0.9);
    expect(r.method).toBe("pooled_cold_start");
    expect(r.qHi).toBeGreaterThan(0);
    expect(r.effective_n).toBeGreaterThan(2);    // it pooled
  });

  it("uses own cohort when it has >= 12 residuals", () => {
    const big = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const cohort = { ATD: big, GUN: [99, -99] };
    const r = pooledColdStartCP(cohort, "ATD", 0.9);
    expect(r.qHi).toBe(1);
  });

  it("returns zero when no cohort has any data", () => {
    const r = pooledColdStartCP({}, "ATD", 0.9);
    expect(r.qHi).toBe(0);
  });
});

// -------------------- selector ----------------------------------

describe("Bet 3 - selectAndComputeCP routing", () => {
  it("< 12 residuals -> pooled_cold_start", () => {
    const r = selectAndComputeCP({
      residuals: [1, 2, 3],
      alpha: 0.95,
      cohortResiduals: { ATD: Array.from({ length: 50 }, (_, i) => i % 4 - 2) },
      cohortKey: "ATD",
    });
    expect(r.method).toBe("pooled_cold_start");
    expect(r.calibration_residuals_count).toBe(3);
  });

  it("< 12 own AND no cohort -> pooled_cold_start with zero band", () => {
    const r = selectAndComputeCP({
      residuals: [1, 2, 3],
      alpha: 0.95,
    });
    expect(r.method).toBe("pooled_cold_start");
    expect(r.qHi).toBe(0);
  });

  it("12-25 residuals -> split_cp regardless of method preference", () => {
    const r = selectAndComputeCP({
      residuals: Array.from({ length: 15 }, (_, i) => i % 3 - 1),
      method: "nexcp",
    });
    expect(r.method).toBe("split_cp");
  });

  it(">= 26 residuals + method=nexcp -> nexcp", () => {
    const r = selectAndComputeCP({
      residuals: Array.from({ length: 30 }, () => 1),
      alpha: 0.95,
      method: "nexcp",
    });
    expect(r.method).toBe("nexcp");
  });

  it(">= 26 residuals + method=split_cp -> split_cp (tenant override)", () => {
    const r = selectAndComputeCP({
      residuals: Array.from({ length: 30 }, () => 1),
      alpha: 0.95,
      method: "split_cp",
    });
    expect(r.method).toBe("split_cp");
  });
});

// -------------------- band + scaling ---------------------------

describe("Bet 3 - intervalForForecast + safetyStockFromInterval", () => {
  it("intervalForForecast clamps lo at zero", () => {
    const { interval_lo, interval_hi } = intervalForForecast({
      pointForecast: 10, qLo: -20, qHi: 5,
    });
    expect(interval_lo).toBe(0);
    expect(interval_hi).toBe(15);
  });

  it("intervalForForecast preserves order (lo <= hi)", () => {
    const { interval_lo, interval_hi } = intervalForForecast({
      pointForecast: 100, qLo: -10, qHi: 10,
    });
    expect(interval_lo).toBe(90);
    expect(interval_hi).toBe(110);
  });

  it("safetyStockFromInterval = max(0, hi - mean)", () => {
    expect(safetyStockFromInterval({ interval_hi: 50, ltdMean: 30 })).toBe(20);
    expect(safetyStockFromInterval({ interval_hi: 50, ltdMean: 100 })).toBe(0);
  });

  it("scaleIntervalToLTD multiplies by L and inflates by sigma*sqrt(L)", () => {
    const r = scaleIntervalToLTD({
      interval_lo: 5, interval_hi: 15, leadTimeWeeks: 4, leadTimeSigmaWeeks: 1,
    });
    // hi = 15*4 + 1*2 = 62; lo = 5*4 - 1*2 = 18
    expect(r.interval_hi_ltd).toBe(62);
    expect(r.interval_lo_ltd).toBe(18);
  });
});

// -------------------- empirical-coverage helper -----------------

describe("Bet 3 - empiricalCoverage", () => {
  it("returns 1 when every actual is inside the band", () => {
    const r = empiricalCoverage([
      { interval_lo: 0, interval_hi: 10, actual: 5 },
      { interval_lo: 0, interval_hi: 10, actual: 7 },
      { interval_lo: 0, interval_hi: 10, actual: 10 },
    ]);
    expect(r.coverage).toBe(1);
    expect(r.n).toBe(3);
  });

  it("returns the right fraction when some fall outside", () => {
    const r = empiricalCoverage([
      { interval_lo: 0, interval_hi: 10, actual: 5 },
      { interval_lo: 0, interval_hi: 10, actual: 15 },   // outside
      { interval_lo: 0, interval_hi: 10, actual: 12 },   // outside
      { interval_lo: 0, interval_hi: 10, actual: 8 },
    ]);
    expect(r.coverage).toBe(0.5);
  });

  it("returns coverage=null when no samples", () => {
    const r = empiricalCoverage([]);
    expect(r.coverage).toBeNull();
  });
});

// -------------------- source-contract regression ---------------

describe("Bet 3 - source contract", () => {
  const migrationSrc = SRC("supabase/migrations/100_inventory_conformal_intervals.sql");
  const cronSrc = SRC("src/api/cron/inventory-planning-weekly.js");
  const calSrc = SRC("src/api/cron/conformal-calibration-weekly.js");
  const diagSrc = SRC("src/api/inventory/conformal_diagnostics.js");
  const routerSrc = SRC("src/api/router.js");
  const clientSrc = SRC("src/client/anvil-client.js");
  const planningTsx = SRC("src/v3-app/screens/inventory-planning.tsx");
  const itemTsx = SRC("src/v3-app/screens/inventory-item.tsx");

  it("migration adds parse_method-style CP columns + RLS table", () => {
    expect(migrationSrc).toMatch(/add column if not exists conformal_method/);
    expect(migrationSrc).toMatch(/add column if not exists coverage_target/);
    expect(migrationSrc).toMatch(/add column if not exists interval_lo/);
    expect(migrationSrc).toMatch(/add column if not exists interval_hi/);
    expect(migrationSrc).toMatch(/create table if not exists conformal_calibration_residuals/);
    expect(migrationSrc).toMatch(/enable row level security/);
  });

  it("migration enforces method enum + coverage range", () => {
    for (const v of ["split_cp", "nexcp", "pooled_cold_start", "parametric_legacy"]) {
      expect(migrationSrc).toMatch(new RegExp("'" + v + "'"));
    }
    expect(migrationSrc).toMatch(/coverage_target > 0\.5 and coverage_target < 1/);
  });

  it("planning cron imports the conformal module + pulls residuals + stamps fields", () => {
    expect(cronSrc).toMatch(/from\s+["']\.\.\/_lib\/inventory\/conformal\.js["']/);
    expect(cronSrc).toMatch(/selectAndComputeCP/);
    expect(cronSrc).toMatch(/conformal_calibration_residuals/);
    expect(cronSrc).toMatch(/conformal_method:/);
    expect(cronSrc).toMatch(/conformal_used/);
  });

  it("step 4b reliability floor is folded into the conformal re-max (override-safe)", () => {
    // Regression guard: the conformal path must re-max the reliability floor, not
    // just the project floor -- otherwise the floor is silently dropped for
    // tenants with BOTH inventory_conformal_enabled and reliability_demand_enabled.
    expect(cronSrc).toMatch(/reliability_demand_enabled/);
    expect(cronSrc).toMatch(/reliabilityFloor\(/);
    expect(cronSrc).toMatch(/Math\.max\(cpSafetyStock,\s*ss\.breakdown\.project_floor,\s*ss\.breakdown\.reliability_floor\)/);
  });

  it("planning cron writes a fresh residual on each run", () => {
    expect(cronSrc).toMatch(/conformal_calibration_residuals/);
    expect(cronSrc).toMatch(/upsert/);
    expect(cronSrc).toMatch(/forecast_value:/);
    expect(cronSrc).toMatch(/actual_value:/);
  });

  it("calibration cron prunes old residuals + walks order_schedule_lines", () => {
    expect(calSrc).toMatch(/order_schedule_lines/);
    expect(calSrc).toMatch(/conformal_calibration_residuals/);
    expect(calSrc).toMatch(/\.delete\(\)/);
    expect(calSrc).toMatch(/inventory_conformal_enabled/);
  });

  it("/api/inventory/conformal_diagnostics handles GET + PATCH and is RBAC-gated", () => {
    expect(diagSrc).toMatch(/req\.method === "GET"/);
    expect(diagSrc).toMatch(/req\.method === "PATCH"/);
    expect(diagSrc).toMatch(/requirePermission\(ctx, "read"\)/);
    expect(diagSrc).toMatch(/requirePermission\(ctx, "admin"\)/);
    expect(diagSrc).toMatch(/conformal_coverage must be in/);
    expect(diagSrc).toMatch(/empiricalCoverage/);
  });

  it("router exposes both the diagnostics endpoint and the calibration cron", () => {
    expect(routerSrc).toMatch(/inventory\/conformal_diagnostics/);
    expect(routerSrc).toMatch(/cron\/conformal-calibration-weekly/);
  });

  it("anvil-client exposes conformalDiagnostics + setConformalOverride", () => {
    expect(clientSrc).toMatch(/conformalDiagnostics:/);
    expect(clientSrc).toMatch(/setConformalOverride:/);
  });

  it("planning screen renders the Coverage tab + method buckets", () => {
    expect(planningTsx).toMatch(/id: "conformal"/);
    expect(planningTsx).toMatch(/method_buckets/);
    expect(planningTsx).toMatch(/empirical_coverage/);
  });

  it("item screen renders the Coverage tab + CP band + picker", () => {
    expect(itemTsx).toMatch(/id: "coverage"/);
    expect(itemTsx).toMatch(/cpVisible/);
    expect(itemTsx).toMatch(/setConformalOverride/);
  });
});
