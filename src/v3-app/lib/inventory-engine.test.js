// Unit tests for the inventory-planning lib helpers (Phase 2).

import { describe, it, expect } from "vitest";
// The engine lives under src/api/_lib/inventory but the vitest root
// is src/v3-app, so we use relative imports out of the root.
import { classifyDemand } from "../../api/_lib/inventory/classify.js";
import { croston, sba, tsb, sma, ses, residualSigma, pickForecaster, wape }
  from "../../api/_lib/inventory/forecast.js";
import { ssNormal, ssGamma, ssProjectFloor, ltdStats, safetyStock, reorderPoint }
  from "../../api/_lib/inventory/safety-stock.js";
import { eoqWilson, eoqCoverage, snapToConstraints, recommendOrderQty }
  from "../../api/_lib/inventory/eoq.js";
import { gammaParams, estimateLeadTime }
  from "../../api/_lib/inventory/lead-time.js";
import {
  STAGE_PROBABILITY_DEFAULTS, resolveOpportunityProbability,
  computePipelineDemand, isoWeekStart, calibrateStageProbabilities,
} from "../../api/_lib/inventory/pipeline-demand.js";
import { projectOnHand, computeNetReq, findShortage, planForItem }
  from "../../api/_lib/inventory/net-req.js";

// ---------------------------------------------------------------- classify

describe("classifyDemand", () => {
  it("returns 'new' for short history", () => {
    expect(classifyDemand([1, 2, 3]).class).toBe("new");
  });

  it("classifies smooth (frequent low-CV) demand", () => {
    const series = Array.from({ length: 52 }, (_, i) => 5 + (i % 2));
    expect(classifyDemand(series).class).toBe("smooth");
  });

  it("classifies intermittent (sparse) demand", () => {
    const series = Array.from({ length: 52 }, (_, i) => (i % 8 === 0 ? 5 : 0));
    expect(classifyDemand(series).class).toBe("intermittent");
  });

  it("classifies lumpy (sparse + high variance) demand", () => {
    const series = Array.from({ length: 52 }, (_, i) => {
      if (i % 8 !== 0) return 0;
      return [1, 30, 5, 80, 12, 2][Math.floor(i / 8) % 6];
    });
    expect(classifyDemand(series).class).toBe("lumpy");
  });
});

// ---------------------------------------------------------------- forecast

describe("forecasters", () => {
  const intermittent = [0, 0, 0, 5, 0, 0, 0, 8, 0, 0, 0, 6, 0, 0, 0, 7];

  it("croston returns positive forecast for intermittent series", () => {
    const out = croston(intermittent);
    expect(out.mean).toBeGreaterThan(0);
    expect(out.model).toBe("croston");
  });

  it("sba is debiased relative to croston (smaller for the same input)", () => {
    const c = croston(intermittent);
    const s = sba(intermittent);
    expect(s.mean).toBeLessThan(c.mean);
  });

  it("tsb decays toward zero when demand stops", () => {
    // Long zero-tail after a brief demand burst. The probability
    // smoother should drag the forecast well below the burst level
    // (6) but it converges geometrically with alphaProb=0.1, so a
    // 30-week tail leaves prob ~ 0.9^30 ~ 0.04. Use a 50-week tail
    // so the forecast lands clearly below 0.5.
    const burst = [5, 0, 6, 0, 7];
    const tail  = Array(50).fill(0);
    const past  = [...burst, ...tail];
    const out = tsb(past);
    expect(out.mean).toBeLessThan(0.5);
  });

  it("sma and ses agree for a flat series", () => {
    const flat = Array(20).fill(4);
    expect(Math.abs(sma(flat, 4).mean - 4)).toBeLessThan(0.01);
    expect(Math.abs(ses(flat).mean - 4)).toBeLessThan(0.01);
  });

  it("residualSigma is non-negative and finite", () => {
    const series = [1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5];
    const sigma = residualSigma(series, sma);
    expect(sigma).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sigma)).toBe(true);
  });

  it("pickForecaster maps demand classes to functions", () => {
    expect(typeof pickForecaster("smooth")).toBe("function");
    expect(typeof pickForecaster("intermittent")).toBe("function");
    expect(typeof pickForecaster("lumpy")).toBe("function");
    expect(typeof pickForecaster("erratic")).toBe("function");
    expect(typeof pickForecaster("new")).toBe("function");
  });

  it("wape returns null when actuals sum to 0", () => {
    expect(wape([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sma, 4)).toBeNull();
  });
});

// ---------------------------------------------------------------- safety stock

describe("safety stock", () => {
  it("ltdStats compounds demand + lead-time variance correctly", () => {
    const out = ltdStats({ demandMean: 10, demandSigma: 2, leadTimeMean: 4, leadTimeSigma: 1 });
    expect(out.ltdMean).toBe(40);
    // Var = 4 * 4 + 100 * 1 = 116; sigma ~ 10.77
    expect(Math.abs(out.ltdSigma - Math.sqrt(116))).toBeLessThan(0.01);
  });

  it("ssNormal scales with z and sigma", () => {
    const ssLow = ssNormal({ alpha: 0.95, ltdSigma: 5 });
    const ssHigh = ssNormal({ alpha: 0.99, ltdSigma: 5 });
    expect(ssHigh).toBeGreaterThan(ssLow);
    // 1.65 * 5 ~ 8.25
    expect(Math.abs(ssLow - 1.645 * 5)).toBeLessThan(0.05);
  });

  it("ssGamma returns non-negative quantile excess", () => {
    const ss = ssGamma({ alpha: 0.95, ltdMean: 30, ltdSigma: 8 });
    expect(ss).toBeGreaterThanOrEqual(0);
  });

  it("ssProjectFloor takes the max of the two inputs", () => {
    expect(ssProjectFloor({ avg4w: 3, projectEquivalentQty: 7 })).toBe(7);
    expect(ssProjectFloor({ avg4w: 12, projectEquivalentQty: 5 })).toBe(12);
  });

  it("safetyStock combines stat + floor and returns the max", () => {
    const out = safetyStock({
      alpha: 0.99, demandMean: 4, demandSigma: 1.2,
      leadTimeMean: 8, leadTimeSigma: 1.5,
      demandClass: "smooth",
      avg4w: 5, projectEquivalentQty: 1,
    });
    expect(out.ss).toBeGreaterThanOrEqual(out.breakdown.stat_ss);
    expect(out.ss).toBeGreaterThanOrEqual(out.breakdown.project_floor);
  });

  it("reorderPoint = ltdMean + ss", () => {
    expect(reorderPoint({ ltdMean: 32, ss: 9 })).toBe(41);
  });
});

// ---------------------------------------------------------------- eoq

describe("EOQ + coverage", () => {
  it("Wilson formula: classic 200-unit test case", () => {
    // D=8000/yr, S=100, H=2 -> Q* = sqrt(2*8000*100/2) = 894
    const q = eoqWilson({ annualDemand: 8000, orderingCost: 100, unitCost: 100, holdingCostPct: 0.02 });
    expect(Math.round(q)).toBe(894);
  });

  it("EOQ returns 0 when any input is non-positive", () => {
    expect(eoqWilson({ annualDemand: 0, orderingCost: 100, unitCost: 100, holdingCostPct: 0.2 })).toBe(0);
    expect(eoqWilson({ annualDemand: 1000, orderingCost: 0, unitCost: 100, holdingCostPct: 0.2 })).toBe(0);
  });

  it("snapToConstraints respects MOQ + pack-size + ceil rounding", () => {
    expect(snapToConstraints(7, { moq: 10, packSize: 5 })).toBe(10);
    expect(snapToConstraints(11, { moq: 10, packSize: 5 })).toBe(15);
    expect(snapToConstraints(0, { moq: 10, packSize: 5 })).toBe(0);
  });

  it("recommendOrderQty picks coverage policy for long-lead items", () => {
    const out = recommendOrderQty({
      weeklyForecast: 4, coverageWeeks: 12, leadTimeWeeks: 10,
      unitCost: 1000, orderingCost: 5000, holdingCostPct: 0.22,
      moq: 1, packSize: 1, roundingRule: "ceil",
    });
    expect(out.policy_source).toBe("rule_based_coverage");
    expect(out.recommended_qty).toBeGreaterThan(0);
  });

  it("recommendOrderQty picks Wilson for short-lead items", () => {
    const out = recommendOrderQty({
      weeklyForecast: 50, coverageWeeks: 4, leadTimeWeeks: 2,
      unitCost: 100, orderingCost: 500, holdingCostPct: 0.22,
      moq: 1, packSize: 1, roundingRule: "ceil",
    });
    expect(out.policy_source).toBe("rule_based_eoq");
  });
});

// ---------------------------------------------------------------- lead time

describe("lead-time estimation", () => {
  it("data-driven when N >= 12", () => {
    const deltas = Array(15).fill(0).map((_, i) => 60 + i);
    const out = estimateLeadTime({ receiptDeltas: deltas, itemDefaultDays: 70 });
    expect(out.source).toBe("data_driven");
    expect(out.sample_size).toBe(15);
  });

  it("priored when 4 <= N < 12", () => {
    const deltas = [50, 55, 60, 65, 70];
    const out = estimateLeadTime({ receiptDeltas: deltas, itemDefaultDays: 70 });
    expect(out.source).toBe("priored");
  });

  it("falls back to item default when N < 4", () => {
    const out = estimateLeadTime({ receiptDeltas: [60, 65], itemDefaultDays: 70 });
    expect(out.source).toBe("item_master_default");
    expect(out.lead_time_days).toBe(70);
  });

  it("gammaParams is well-formed", () => {
    const gp = gammaParams(40, 8);
    expect(gp.shape).toBeGreaterThan(0);
    expect(gp.scale).toBeGreaterThan(0);
    // shape * scale = mean
    expect(Math.abs(gp.shape * gp.scale - 40)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------- pipeline demand

describe("pipeline demand", () => {
  it("STAGE_PROBABILITY_DEFAULTS covers every stage in the spec", () => {
    expect(STAGE_PROBABILITY_DEFAULTS.QUALIFICATION).toBeDefined();
    expect(STAGE_PROBABILITY_DEFAULTS.PROPOSAL_PRICE_QUOTE).toBe(0.6);
    expect(STAGE_PROBABILITY_DEFAULTS.CLOSE_LOST).toBe(0);
    expect(STAGE_PROBABILITY_DEFAULTS.CLOSE_WON).toBe(1);
  });

  it("resolveOpportunityProbability prefers operator override", () => {
    expect(resolveOpportunityProbability({ stage: "QUALIFICATION", probability: 0.8 })).toBe(0.8);
  });

  it("resolveOpportunityProbability falls back to stage default", () => {
    expect(resolveOpportunityProbability({ stage: "PROPOSAL_PRICE_QUOTE" })).toBe(0.6);
  });

  it("isoWeekStart anchors on Monday", () => {
    // 2026-05-08 is a Friday; the ISO week starts on 2026-05-04.
    expect(isoWeekStart("2026-05-08")).toBe("2026-05-04");
  });

  it("computePipelineDemand sums probability-weighted qty per part per week", () => {
    const pairs = [
      { opp: { stage: "PROPOSAL_PRICE_QUOTE", close_date: "2026-06-05" },   // Friday
        lines: [{ part_no: "ATD-1", qty: 10, expected_close_date: null }] },
      { opp: { stage: "FOLLOW_UP", close_date: "2026-06-05" },
        lines: [{ part_no: "ATD-1", qty: 4, expected_close_date: null }] },
    ];
    const out = computePipelineDemand({ pairs });
    const wk = isoWeekStart("2026-06-05");
    const atd = out.get("ATD-1");
    expect(atd).toBeTruthy();
    // 10 * 0.60 + 4 * 0.85 = 9.4
    expect(Math.abs(atd.get(wk) - 9.4)).toBeLessThan(1e-6);
  });

  it("calibrateStageProbabilities uses defaults until a stage has 10+ samples", () => {
    const history = Array(15).fill({ max_stage: "RFQ", final_stage: "CLOSE_WON" });
    const out = calibrateStageProbabilities(history);
    expect(out.RFQ).toBe(1);
    // Stages with no history fall back to defaults.
    expect(out.QUALIFICATION).toBe(STAGE_PROBABILITY_DEFAULTS.QUALIFICATION);
  });
});

// ---------------------------------------------------------------- net req

describe("net-req engine", () => {
  it("projectOnHand integrates in-transit and allocations correctly", () => {
    const weeks = ["2026-05-04", "2026-05-11", "2026-05-18"];
    const inTransit = new Map([["2026-05-11", 5]]);
    const allocated = new Map([["2026-05-18", 3]]);
    const out = projectOnHand({ onHand: 10, inTransitByWeek: inTransit, allocatedByWeek: allocated, weeks });
    expect(out[0].projected_oh).toBe(10);
    expect(out[1].projected_oh).toBe(15);
    expect(out[2].projected_oh).toBe(12);
  });

  it("computeNetReq detects shortages", () => {
    const projected = [
      { week: "wk1", projected_oh: 5 },
      { week: "wk2", projected_oh: 3 },
      { week: "wk3", projected_oh: 1 },
    ];
    const forecasts = new Map([["wk1", 4], ["wk2", 4], ["wk3", 4]]);
    const out = computeNetReq({ forecastByWeek: forecasts, projectedOH: projected, safetyStock: 2 });
    // wk1: (4+2) - 5 = 1 (short by 1)
    expect(out[0].net_req).toBe(1);
    expect(out[1].net_req).toBe(3);
    expect(out[2].net_req).toBe(5);
  });

  it("findShortage returns null when fully covered", () => {
    const curve = [{ week: "wk1", net_req: -2 }, { week: "wk2", net_req: -1 }];
    expect(findShortage({ netReqCurve: curve, leadTimeWeeks: 10 })).toBeNull();
  });

  it("findShortage sums shortage qty within the lead-time window", () => {
    const curve = [
      { week: "wk1", net_req: 0 },
      { week: "wk2", net_req: 2 },
      { week: "wk3", net_req: 3 },
      { week: "wk4", net_req: 1 },
    ];
    const out = findShortage({ netReqCurve: curve, leadTimeWeeks: 2 });
    // First shortage at wk2; sum within 2-week window: wk2 (2) + wk3 (3) = 5
    expect(out.first_week).toBe("wk2");
    expect(out.needed_qty).toBe(5);
  });

  it("planForItem returns null plan when no shortage", () => {
    const result = planForItem({
      partNo: "X",
      position: { on_hand_qty: 100 },
      forecastByWeek: new Map([["wk1", 1]]),
      forecastDecompByWeek: new Map(),
      inTransitByWeek: new Map(),
      allocatedByWeek: new Map(),
      weeks: ["wk1"],
      safetyStockQty: 5,
      leadTimeWeeks: 4,
      weeklyForecastMean: 1,
      coverageWeeks: 4,
      unitCost: 1, orderingCost: 100, holdingCostPct: 0.2,
      moq: 1, packSize: 1, roundingRule: "ceil",
      serviceLevel: 0.95,
    });
    expect(result.plan).toBeNull();
  });

  it("planForItem builds a plan when there is a shortage", () => {
    // Use real ISO week dates so addWeeks can parse them.
    const wk1 = "2026-05-04";
    const wk2 = "2026-05-11";
    const result = planForItem({
      partNo: "X",
      position: { on_hand_qty: 0 },
      forecastByWeek: new Map([[wk1, 5], [wk2, 5]]),
      forecastDecompByWeek: new Map([[wk1, { committed: 3, pipeline: 1, baseline: 1 }]]),
      inTransitByWeek: new Map(),
      allocatedByWeek: new Map(),
      weeks: [wk1, wk2],
      safetyStockQty: 2,
      leadTimeWeeks: 4,
      weeklyForecastMean: 5,
      coverageWeeks: 8,
      unitCost: 100, orderingCost: 500, holdingCostPct: 0.2,
      moq: 5, packSize: 5, roundingRule: "ceil",
      serviceLevel: 0.99,
      topOpps: [],
      hysteresisStreak: 1,
    });
    expect(result.plan).toBeTruthy();
    expect(result.plan.recommended_qty).toBeGreaterThanOrEqual(5);
    expect(result.plan.policy_source).toMatch(/coverage|eoq/);
    expect(result.plan.rationale).toBeTruthy();
  });
});
