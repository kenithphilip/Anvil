// Dense-history cadence fix (migration 176). Verifies denseHistory rebuilds a
// true weekly grid (real interior/trailing zeros) vs the sparse-pad path, that the
// two agree when demand is already dense (so the fix is a no-op there), and that
// the cadence correction changes the intermittent forecasters -- most sharply TSB
// (the sparse path pins demand-probability high) and the avg4w recent tail.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { denseHistory, sparseHistory } from "../api/_lib/inventory/history.js";
import { addWeeks } from "../api/_lib/inventory/net-req.js";
import { croston, tsb } from "../api/_lib/inventory/forecast.js";

const H = 104;
const today = "2026-07-13";
const wk = (off) => addWeeks(today, off);

describe("denseHistory structure", () => {
  it("returns exactly historyWeeks entries, chronological, ending at today", () => {
    const m = new Map([[wk(-(H - 1)), 5], [wk(-1), 7], [wk(0), 3]]);
    const arr = denseHistory(m, today, H);
    expect(arr.length).toBe(H);
    expect(arr[0]).toBe(5);        // oldest week
    expect(arr[H - 2]).toBe(7);    // last complete week
    expect(arr[H - 1]).toBe(3);    // current week
    expect(arr.reduce((s, v) => s + v, 0)).toBe(15);
  });

  it("preserves real interior spacing (sparse packs them adjacent)", () => {
    const m = new Map([[wk(-30), 10], [wk(-20), 10], [wk(-10), 10]]);
    const dense = denseHistory(m, today, H);
    // index = offset + (H-1)
    expect(dense[H - 1 - 30]).toBe(10);
    expect(dense[H - 1 - 20]).toBe(10);
    expect(dense[H - 1 - 10]).toBe(10);
    expect(dense[H - 1 - 25]).toBe(0);          // interior gap is a real zero
    expect(dense.slice(-3)).toEqual([0, 0, 0]); // last demand was 10 weeks ago
    const sparse = sparseHistory(m, H);
    expect(sparse.slice(-3)).toEqual([10, 10, 10]); // sparse jams them at the end
    expect(dense.reduce((s, v) => s + v, 0)).toBe(sparse.reduce((s, v) => s + v, 0)); // same total
  });
});

describe("flag-off equivalence + no-op on dense demand", () => {
  it("sparseHistory reproduces the original assembly (length + left-pad)", () => {
    const m = new Map([[wk(-2), 4], [wk(0), 6]]);
    const arr = sparseHistory(m, H);
    expect(arr.length).toBe(H);
    expect(arr.slice(-2)).toEqual([4, 6]);       // sorted values, packed at end
    expect(arr.slice(0, H - 2).every((v) => v === 0)).toBe(true);
  });

  it("agrees with sparse when demand fills every recent week (no gaps to fix)", () => {
    const m = new Map();
    for (let o = -(H - 1); o <= 0; o += 1) m.set(wk(o), 10);
    const dense = denseHistory(m, today, H);
    const sparse = sparseHistory(m, H);
    expect(dense).toEqual(sparse);               // fix is a no-op on dense demand
    expect(croston(dense).mean).toBe(croston(sparse).mean);
  });
});

describe("cadence fix changes intermittent forecasters", () => {
  const m = new Map([[wk(-80), 10], [wk(-40), 10], [wk(-5), 10]]); // 3 gappy events
  const dense = denseHistory(m, today, H);
  const sparse = sparseHistory(m, H);

  it("TSB: sparse pins probability high (over-forecasts); dense corrects it down", () => {
    expect(tsb(sparse).mean).toBeGreaterThan(tsb(dense).mean);
    expect(tsb(sparse).mean).toBeCloseTo(10, 3);   // sparse ~= last size (prob ~1)
    expect(tsb(dense).mean).toBeLessThan(2);       // dense sees the dormancy
  });

  it("avg4w recent tail: sparse shows fake recent demand, dense shows real zeros", () => {
    const avg = (a) => a.slice(-4).reduce((s, v) => s + v, 0) / 4;
    expect(avg(sparse)).toBeGreaterThan(0);
    expect(avg(dense)).toBe(0);                    // last demand was 5 weeks ago
  });

  it("changes the Croston forecast (cadence-corrected, direction by frequency)", () => {
    expect(croston(dense).mean).not.toBe(croston(sparse).mean);
  });
});

// Guards the exact regression the review caught: the histArr assembly moved into
// history.js, so the conformal residual-capture block must NOT reference the
// removed sorted-keys array (a dangling reference crashed planTenant for every
// conformal tenant), and must derive the newest-week key layout-aware.
describe("cron wiring (source contract)", () => {
  const cronSrc = readFileSync(resolve(process.cwd(), "src/api/cron/inventory-planning-weekly.js"), "utf8");
  it("assembles histArr via the gated dense/sparse branch", () => {
    expect(cronSrc).toContain("denseHistory(histMap, today, HISTORY_WEEKS)");
    expect(cronSrc).toContain("sparseHistory(histMap, HISTORY_WEEKS)");
  });
  it("leaves no dangling histKeys reference; residual week is layout-aware", () => {
    expect(cronSrc).not.toMatch(/histKeys/);              // the removed variable
    expect(cronSrc).toContain("denseHistoryOn ? today :"); // layout-aware lastWeekKey
  });
});
