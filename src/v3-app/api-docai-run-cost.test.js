// Unit tests for src/api/_lib/docai/run-cost.js (Wave 1.4).

import { describe, it, expect } from "vitest";
import {
  createRunCostAccumulator,
  DEFAULT_PER_EXTRACTION_CAP_USD,
  MAX_PER_EXTRACTION_CAP_USD,
  estimatedCostFor,
  __test,
} from "../api/_lib/docai/run-cost.js";

describe("estimatedCostFor", () => {
  it("returns the cost_guard.DEFAULT_COST_USD value for known adapters", () => {
    expect(estimatedCostFor("claude")).toBeGreaterThan(0);
    expect(estimatedCostFor("docling")).toBe(0);
  });
  it("returns 0 for unknown adapters", () => {
    expect(estimatedCostFor("does-not-exist")).toBe(0);
  });
});

describe("__test.resolveCap", () => {
  it("falls back to default on null / NaN / non-positive", () => {
    expect(__test.resolveCap(null)).toBe(DEFAULT_PER_EXTRACTION_CAP_USD);
    expect(__test.resolveCap("nope")).toBe(DEFAULT_PER_EXTRACTION_CAP_USD);
    expect(__test.resolveCap(0)).toBe(DEFAULT_PER_EXTRACTION_CAP_USD);
    expect(__test.resolveCap(-1)).toBe(DEFAULT_PER_EXTRACTION_CAP_USD);
  });
  it("clamps at MAX_PER_EXTRACTION_CAP_USD", () => {
    expect(__test.resolveCap(999)).toBe(MAX_PER_EXTRACTION_CAP_USD);
  });
  it("respects a valid number", () => {
    expect(__test.resolveCap(2.5)).toBe(2.5);
  });
});

describe("createRunCostAccumulator", () => {
  it("accumulates costs and surfaces totalUsd", () => {
    const acc = createRunCostAccumulator(1);
    acc.add("claude", 0.022);
    acc.add("claude", 0.022);
    expect(acc.totalUsd).toBeCloseTo(0.044, 6);
    expect(acc.calls.length).toBe(2);
  });

  it("wouldExceed returns true when next call would breach", () => {
    const acc = createRunCostAccumulator(0.05);
    acc.add("claude", 0.022);
    acc.add("claude", 0.022);
    expect(acc.wouldExceed("claude", 0.022)).toBe(true);
  });

  it("wouldExceed returns false when next call fits", () => {
    const acc = createRunCostAccumulator(0.1);
    acc.add("claude", 0.022);
    expect(acc.wouldExceed("claude", 0.022)).toBe(false);
  });

  it("skip records into the skipped log without consuming budget", () => {
    const acc = createRunCostAccumulator(1);
    acc.add("gemini", 0.0035);
    acc.skip("claude", "over_run_budget");
    expect(acc.totalUsd).toBeCloseTo(0.0035, 6);
    expect(acc.skipped.length).toBe(1);
    expect(acc.skipped[0].adapter).toBe("claude");
  });

  it("summary returns a jsonb-friendly snapshot", () => {
    const acc = createRunCostAccumulator(0.5);
    acc.add("gemini", 0.01);
    acc.add("claude", 0.02);
    const s = acc.summary();
    expect(s.cap_usd).toBe(0.5);
    expect(s.total_usd).toBeCloseTo(0.03, 6);
    expect(s.breached).toBe(false);
    expect(s.call_count).toBe(2);
  });

  it("summary marks breached=true once the total exceeds cap", () => {
    const acc = createRunCostAccumulator(0.05);
    acc.add("claude", 0.04);
    acc.add("claude", 0.04);                // total 0.08 > 0.05
    expect(acc.summary().breached).toBe(true);
    expect(acc.hasExceeded()).toBe(true);
  });

  it("uses the cost_guard adapter table by default when perCallUsd is omitted", () => {
    const acc = createRunCostAccumulator(1);
    acc.add("claude");                       // pulls from DEFAULT_COST_USD
    expect(acc.totalUsd).toBeGreaterThan(0);
  });
});
