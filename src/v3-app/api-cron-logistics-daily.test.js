// The logistics monitor's daily backstop.
//
// The monitor was registered only in tick.js's 5-min ALWAYS group. That group
// runs solely when the external cron-job.org trigger is configured and live:
// Vercel's Hobby tier rejects any sub-daily schedule, so vercel.json schedules
// nothing but /api/cron/daily (docs/CRONS.md). Flipping
// logistics_monitor_enabled on therefore guaranteed nothing.
//
// Registering it in the daily group is the fix, but the naming is load-bearing.
// Every handler name is a row in cron_health, and probeCronFreshness flags a row
// stale past its bound — /api/_healthz returns 503 when anything is stale. Reuse
// tick.js's "logistics/monitor" name and a once-daily write lands against a
// 10-minute bound: stale ~23h50m a day, healthz pinned at 503, and the 5-min row
// looking freshly written when the external trigger is actually dead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CRON_EXPECTED_MAX_AGE_MS } from "../api/_lib/heartbeat-check.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const daily = read("../api/cron/daily.js");
const tick = read("../api/cron/tick.js");
const vercel = JSON.parse(read("../../vercel.json"));

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the daily group runs the logistics monitor", () => {
  it("registers the tick handler", () => {
    expect(daily).toContain("logistics-monitor-tick.js");
    expect(daily).toMatch(/name:\s*"logistics\/monitor_daily"/);
  });

  it("points it at the handler's real path", () => {
    expect(daily).toContain('path: "/api/cron/logistics-monitor-tick"');
  });

  it("does not reuse the 5-minute group's worker name", () => {
    // The regression this file exists for.
    expect(tick).toMatch(/name:\s*"logistics\/monitor"/);
    expect(daily).not.toMatch(/name:\s*"logistics\/monitor"[^_]/);
  });

  it("leaves the 5-minute registration in place", () => {
    // The daily run is a backstop, not a replacement. If the external trigger
    // is live, 5-minute detection is the behaviour we want to keep.
    expect(tick).toContain("logistics-monitor-tick.js");
  });
});

describe("staleness bounds match the cadence each row is actually written at", () => {
  it("gives the daily registration a daily bound", () => {
    expect(CRON_EXPECTED_MAX_AGE_MS["logistics/monitor_daily"]).toBeGreaterThan(DAY_MS);
  });

  it("gives the handler's self-recorded row a daily bound too", () => {
    // logistics-monitor-tick.js calls recordCronHeartbeat("logistics-monitor-tick")
    // from inside the handler, so that row is written by WHICHEVER path ran. On
    // the 10-minute default a daily-only deployment would hold healthz at 503.
    expect(CRON_EXPECTED_MAX_AGE_MS["logistics-monitor-tick"]).toBeGreaterThan(DAY_MS);
  });

  it("keeps the 5-minute group row on a tight bound", () => {
    // This is the row that still reports whether the external trigger is alive.
    // Relaxing it would hide a dead trigger behind the daily backstop.
    const v = CRON_EXPECTED_MAX_AGE_MS["logistics/monitor"] ?? CRON_EXPECTED_MAX_AGE_MS.default;
    expect(v).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("still bounds cron/tick tightly, as the trigger's canary", () => {
    expect(CRON_EXPECTED_MAX_AGE_MS["cron/tick"]).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("does not loosen the shared default", () => {
    // Relaxing `default` would silence every unlisted worker at once — the
    // failure mode heartbeat-check.js's own header warns against.
    expect(CRON_EXPECTED_MAX_AGE_MS.default).toBe(10 * 60 * 1000);
  });
});

describe("vercel.json still only schedules the daily path", () => {
  it("schedules exactly one cron", () => {
    // A sub-daily entry fails the Hobby-tier build outright. This is the guard
    // against someone 'fixing' the 5-minute gap the obvious way.
    expect(vercel.crons).toHaveLength(1);
    expect(vercel.crons[0].path).toBe("/api/cron/daily");
  });

  it("uses a once-a-day schedule expression", () => {
    // Five fields, and neither minute nor hour may be a */n step.
    const [minute, hour] = vercel.crons[0].schedule.split(/\s+/);
    expect(vercel.crons[0].schedule.split(/\s+/)).toHaveLength(5);
    expect(minute).not.toMatch(/[*/,-]/);
    expect(hour).not.toMatch(/[*/,-]/);
  });
});

describe("the daily module's own description is accurate", () => {
  it("does not claim the group is sequenced", () => {
    // runCronGroup is Promise.allSettled. The header used to say "Sequenced
    // (not parallel)", which is the opposite of what it does — and the basis on
    // which someone would reason about starving a handler added at the end.
    expect(daily).not.toMatch(/Sequenced \(not parallel\)/);
    expect(daily).toMatch(/parallel/i);
  });
});
