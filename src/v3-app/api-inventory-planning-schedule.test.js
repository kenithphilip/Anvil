// The planner must have a clock, and it must be the right clock.
//
// cron/inventory-planning-weekly.js was registered in router.js and appeared in
// neither cron fan-out, while /api/cron/daily is the only Vercel cron entry, so
// nothing ever ran it. cron/daily.js now carries it, gated to one UTC weekday
// (INVENTORY_PLANNING_DAY, default Monday, -1 off).
//
// These tests drive the real daily handler. Every sub-handler is a stub that
// records being called, the clock is faked, and cron_health is an in-memory
// table, so what is asserted is what the handler does on a given day: which
// handlers it calls, with what budget, and what the staleness sweep it runs
// afterwards concludes about the planner's heartbeat rows.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "planner-schedule-test-secret");
  const calls = [];
  const cronHealth = new Map();
  const stub = (name) => async (req, res) => {
    calls.push({ name, path: req.url });
    res.status(200).json({ ok: true });
  };
  return { calls, cronHealth, stub };
});

vi.mock("../api/analytics/refresh.js", () => ({ default: h.stub("analytics/refresh") }));
vi.mock("../api/fx/cron.js", () => ({ default: h.stub("fx/cron") }));
vi.mock("../api/service/amc_cron.js", () => ({ default: h.stub("service/amc_cron") }));
vi.mock("../api/rlhf/aggregate.js", () => ({ default: h.stub("rlhf/aggregate") }));
vi.mock("../api/quotes/expire.js", () => ({ default: h.stub("quotes/expire") }));
vi.mock("../api/billing/recurring_cron.js", () => ({ default: h.stub("billing/recurring") }));
vi.mock("../api/eway_bills/expire.js", () => ({ default: h.stub("eway_bills/expire") }));
vi.mock("../api/catalog/embed.js", () => ({ default: h.stub("catalog/embed") }));
vi.mock("../api/cron/drift-report.js", () => ({ default: h.stub("drift-report") }));
vi.mock("../api/cron/eval_quality_alert.js", () => ({ default: h.stub("eval/quality_alert") }));
vi.mock("../api/cron/extraction_reaper.js", () => ({ default: h.stub("docai/extraction_reaper") }));
vi.mock("../api/cron/inventory-planning-weekly.js", () => ({ default: h.stub("planner") }));
vi.mock("../api/eval/replay.js", () => ({ default: h.stub("eval/replay") }));
vi.mock("../api/cron/logistics-monitor-tick.js", () => ({ default: h.stub("logistics/monitor_daily") }));
vi.mock("../api/forecast/index.js", () => ({ default: h.stub("forecast/snapshot") }));

// cron_health is the only table the daily handler itself touches: one heartbeat
// upsert per row, and the staleness probe's read of every row.
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: (table) => {
      if (table !== "cron_health") throw new Error("unexpected table " + table);
      let worker = null;
      const q = {
        select: () => q,
        order: () => q,
        eq: (_col, value) => { worker = value; return q; },
        maybeSingle: () => Promise.resolve({ data: h.cronHealth.get(worker) || null, error: null }),
        upsert: (row) => {
          h.cronHealth.set(row.worker, { ...row });
          return Promise.resolve({ error: null });
        },
        then: (ok, bad) => Promise.resolve({ data: [...h.cronHealth.values()], error: null }).then(ok, bad),
      };
      return q;
    },
  }),
}));

import dailyHandler from "../api/cron/daily.js";
import { makeMockRes, cronHandlerBudgetMs } from "../api/_lib/cron-mux.js";
import { probeCronFreshness } from "../api/_lib/heartbeat-check.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-10-04 is a Sunday, so day offset d below is also getUTCDay() === d.
const SUNDAY = Date.UTC(2026, 9, 4, 2, 30);
const PLANNER_ROW = "inventory/planning_weekly";

const saved = {};
const ENV_KEYS = ["INVENTORY_PLANNING_DAY", "EVAL_REPLAY_ENABLED"];
let warn;

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  h.calls.length = 0;
  h.cronHealth.clear();
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  warn.mockRestore();
});

const setPlanningDay = (value) => { process.env.INVENTORY_PLANNING_DAY = value; };

// One real invocation of /api/cron/daily at the given instant.
const runDaily = async (at) => {
  vi.setSystemTime(new Date(at));
  const before = h.calls.length;
  const { res, _outcome } = makeMockRes();
  await dailyHandler({
    method: "GET",
    url: "/api/cron/daily",
    headers: { authorization: "Bearer planner-schedule-test-secret" },
  }, res);
  const calls = h.calls.slice(before);
  return {
    status: _outcome.statusCode,
    body: JSON.parse(_outcome.body),
    planner: calls.filter((c) => c.name === "planner"),
    calls,
  };
};

// Run the daily cron once on each day of one week (Sunday first) and return
// the getUTCDay() values on which the planner was called.
const plannedWeekdays = async () => {
  const days = [];
  for (let d = 0; d < 7; d++) {
    const r = await runDaily(SUNDAY + d * DAY_MS);
    expect(r.status).toBe(200);
    if (r.planner.length) days.push(d);
  }
  return days;
};

const dayWarnings = () => warn.mock.calls
  .map((args) => String(args[0]))
  .filter((line) => line.includes("INVENTORY_PLANNING_DAY"));

describe("the daily cron runs the planner on the planning weekday only", () => {
  it("unset: Monday UTC and no other day, while the rest of the group runs daily", async () => {
    expect(await plannedWeekdays()).toEqual([1]);
    // The positive control: the stubs are wired, so a missing planner call
    // means the handler skipped it, not that nothing ran.
    expect(h.calls.filter((c) => c.name === "fx/cron")).toHaveLength(7);
    expect(dayWarnings()).toEqual([]);
  });

  it("calls the planner once, at its own path, under its own cron_health row", async () => {
    const r = await runDaily(SUNDAY + 1 * DAY_MS);
    expect(r.planner).toEqual([{ name: "planner", path: "/api/cron/inventory-planning-weekly" }]);
    const row = r.body.results.find((x) => x.name === PLANNER_ROW);
    expect(row).toMatchObject({ ok: true, status: 200 });
    expect(h.cronHealth.get(PLANNER_ROW)).toMatchObject({ worker: PLANNER_ROW, last_status: "ok" });
  });

  it("blank or whitespace means the default Monday, not Sunday", async () => {
    // Number("") is 0, which used to move the planner to Sunday silently.
    setPlanningDay("");
    expect(await plannedWeekdays()).toEqual([1]);
    setPlanningDay("   ");
    expect(await plannedWeekdays()).toEqual([1]);
    expect(dayWarnings()).toEqual([]);
  });

  it("-1 switches it off on every day, and is not reported as a mistake", async () => {
    setPlanningDay("-1");
    expect(await plannedWeekdays()).toEqual([]);
    expect(h.calls.filter((c) => c.name === "fx/cron")).toHaveLength(7);
    expect(dayWarnings()).toEqual([]);
  });

  it("each of 0..6 runs it on exactly that UTC weekday", async () => {
    for (let day = 0; day <= 6; day++) {
      setPlanningDay(String(day));
      expect(await plannedWeekdays()).toEqual([day]);
    }
    expect(dayWarnings()).toEqual([]);
  });

  it("a malformed value is refused: no run on any day, and a warning naming it on every run", async () => {
    for (const bad of ["Mon", "monday", "7", "-2", "1.5", "1,3"]) {
      warn.mockClear();
      setPlanningDay(bad);
      expect(await plannedWeekdays()).toEqual([]);
      const lines = dayWarnings();
      expect(lines).toHaveLength(7);
      expect(lines[0]).toContain(JSON.stringify(bad));
      expect(lines[0]).toContain("will not run");
    }
  });

  it("refuses a number that only parses to a weekday, rather than guessing which one was meant", async () => {
    for (const bad of ["01", "1.0", "+1", "1e0", "0x1", " 1 1"]) {
      warn.mockClear();
      setPlanningDay(bad);
      expect(await plannedWeekdays()).toEqual([]);
      expect(dayWarnings()).toHaveLength(7);
    }
  });
});

describe("the planner's budget leaves the daily function room to finish", () => {
  it("is wider than the default slice but leaves at least 15s of the function ceiling", async () => {
    const vercelPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vercel.json");
    const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
    const ceilingMs = vercel.functions["api/dispatch.js"].maxDuration * 1000;
    const r = await runDaily(SUNDAY + 1 * DAY_MS);
    const budget = r.body.results.find((x) => x.name === PLANNER_ROW).budget_ms;
    // After the parallel group the handler still writes about 16 heartbeats in
    // sequence and runs the staleness probe. 55s left about 5s for that.
    expect(ceilingMs - budget).toBeGreaterThanOrEqual(15_000);
    expect(budget).toBeGreaterThan(cronHandlerBudgetMs(PLANNER_ROW));
  });
});

describe("a weekly row is judged against a weekly bound", () => {
  it("the daily run's own staleness sweep keeps the planner row fresh until the next planning day", async () => {
    await runDaily(SUNDAY + 1 * DAY_MS);
    const writtenAt = h.cronHealth.get(PLANNER_ROW).last_run_at;
    // Every later day of the week, the sweep that runs at the end of
    // /api/cron/daily must not call the Monday row stale. On the 10-minute
    // default it did from the Tuesday on.
    for (let d = 2; d <= 7; d++) {
      const r = await runDaily(SUNDAY + d * DAY_MS);
      expect(r.body.staleness_check.any_stale).toBe(false);
      expect(r.body.staleness_check.stale_workers).toEqual([]);
    }
    // The next Monday's run, an hour late, before the planner has rewritten
    // its row: the row is then a full week and an hour old and must still
    // read fresh. The planner is switched off for this run so the row the
    // sweep sees is the one from a week ago.
    setPlanningDay("-1");
    const r = await runDaily(SUNDAY + 8 * DAY_MS + 60 * 60 * 1000);
    expect(h.cronHealth.get(PLANNER_ROW).last_run_at).toBe(writtenAt);
    expect(r.body.staleness_check.stale_workers).toEqual([]);
  });

  it("a missed week still shows as stale", async () => {
    await runDaily(SUNDAY + 1 * DAY_MS);
    setPlanningDay("-1");
    // Nine days on, with no planner run since: the sweep must say so.
    const r = await runDaily(SUNDAY + 10 * DAY_MS);
    expect(r.body.staleness_check.stale_workers).toEqual([PLANNER_ROW]);
  });

  it("the row the planner records for itself gets the same weekly bound", async () => {
    // inventory-planning-weekly.js calls recordCronHeartbeat under its own name,
    // so a second weekly row exists alongside the daily group's.
    const now = SUNDAY + 8 * DAY_MS;
    vi.setSystemTime(new Date(now));
    const write = (worker, ageMs) => h.cronHealth.set(worker, {
      worker, last_run_at: new Date(now - ageMs).toISOString(), last_status: "ok",
    });
    write("inventory-planning-weekly", 7 * DAY_MS + 60 * 60 * 1000);
    write("cron/tick", 60 * 1000);
    let r = await probeCronFreshness();
    expect(r.stale_workers).toEqual([]);
    expect(r.workers.find((w) => w.worker === "inventory-planning-weekly").stale).toBe(false);

    write("inventory-planning-weekly", 9 * DAY_MS);
    r = await probeCronFreshness();
    expect(r.stale_workers).toEqual(["inventory-planning-weekly"]);
  });
});
