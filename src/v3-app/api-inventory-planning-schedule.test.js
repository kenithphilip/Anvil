// The planner must have a clock.
//
// cron/inventory-planning-weekly.js computes demand classification, a chosen
// forecaster, conformal intervals, a gamma-fitted lead time, safety stock, the
// net-requirement curve and draft procurement plans -- and NOTHING triggered
// it: registered in router.js, absent from both cron fan-outs, while
// /api/cron/daily is the only Vercel cron entry.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPlanningDay } from "../api/cron/daily.js";

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("isPlanningDay", () => {
  it("fires on exactly one weekday (Monday UTC by default), not every day", () => {
    // 2026-08-31 is a Monday; 2026-09-01 a Tuesday.
    expect(isPlanningDay(new Date("2026-08-31T02:30:00Z"))).toBe(true);
    expect(isPlanningDay(new Date("2026-09-01T02:30:00Z"))).toBe(false);
    expect(isPlanningDay(new Date("2026-08-30T02:30:00Z"))).toBe(false); // Sunday
  });

  it("runs on exactly 1 of any 7 consecutive days", () => {
    let hits = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.UTC(2026, 7, 31 + d, 2, 30));
      if (isPlanningDay(day)) hits += 1;
    }
    expect(hits).toBe(1);
  });
});

describe("the daily fan-out actually carries the planner", () => {
  const src = read("src/api/cron/daily.js");

  it("imports and registers it, gated to the planning day", () => {
    expect(src).toMatch(/import inventoryPlanning from "\.\/inventory-planning-weekly\.js"/);
    expect(src).toMatch(/isPlanningDay\(\)/);
    expect(src).toMatch(/name: "inventory\/planning_weekly"/);
    expect(src).toMatch(/path: "\/api\/cron\/inventory-planning-weekly"/);
  });

  it("gives it a real timeout budget, like the other heavy handler", () => {
    // A per-tenant x per-item planning loop cannot finish in a default slice,
    // and cron-mux races each handler against its budget.
    expect(src).toMatch(/name: "inventory\/planning_weekly".*timeoutMs: 55000/s);
  });
});

describe("switching it on cannot change anybody's data until they opt in", () => {
  const planner = read("src/api/cron/inventory-planning-weekly.js");

  it("skips a tenant without inventory_planning_enabled", () => {
    expect(planner).toMatch(/inventory_planning_enabled/);
    expect(planner).toMatch(/skipped: true/);
  });

  it("only touches items flagged planning_enabled", () => {
    expect(planner).toMatch(/\.eq\("planning_enabled", true\)/);
  });

  it("drafts procurement plans rather than committing them", () => {
    expect(planner).toMatch(/procurement_plans/);
    expect(planner).toMatch(/draft/i);
  });
});
