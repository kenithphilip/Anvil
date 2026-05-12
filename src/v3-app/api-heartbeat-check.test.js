// Unit tests for src/api/_lib/heartbeat-check.js.
//
// Mocks the Supabase service client so the cron_health summary
// can be exercised without a live database. Confirms staleness
// classification per worker + the alert sink behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockRows = [];
let mockError = null;

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: mockRows, error: mockError }),
      }),
    }),
  }),
}));

const importer = () => import("../api/_lib/heartbeat-check.js");

beforeEach(() => {
  mockRows = [];
  mockError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeCronFreshness", () => {
  it("marks cron/tick stale when last_run_at is older than 10 minutes", async () => {
    const { probeCronFreshness } = await importer();
    mockRows = [
      { worker: "cron/tick", last_run_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(), last_status: "ok" },
      { worker: "cron/daily", last_run_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(), last_status: "ok" },
    ];
    const r = await probeCronFreshness();
    expect(r.tick_stale).toBe(true);
    expect(r.daily_stale).toBe(false);
    expect(r.any_stale).toBe(true);
    expect(r.stale_workers).toEqual(["cron/tick"]);
  });

  it("treats a 7-minute-old tick as fresh", async () => {
    const { probeCronFreshness } = await importer();
    mockRows = [
      { worker: "cron/tick", last_run_at: new Date(Date.now() - 7 * 60 * 1000).toISOString(), last_status: "ok" },
    ];
    const r = await probeCronFreshness();
    expect(r.tick_stale).toBe(false);
    expect(r.any_stale).toBe(false);
  });

  it("treats a daily-cron 30-hour-old run as stale", async () => {
    const { probeCronFreshness } = await importer();
    mockRows = [
      { worker: "cron/daily", last_run_at: new Date(Date.now() - 31 * 60 * 60 * 1000).toISOString(), last_status: "ok" },
    ];
    const r = await probeCronFreshness();
    expect(r.daily_stale).toBe(true);
    expect(r.any_stale).toBe(true);
  });

  it("falls back to the default 10-minute bound for unknown workers", async () => {
    const { probeCronFreshness } = await importer();
    mockRows = [
      { worker: "some/unknown-worker", last_run_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(), last_status: "ok" },
    ];
    const r = await probeCronFreshness();
    expect(r.any_stale).toBe(true);
    expect(r.stale_workers).toEqual(["some/unknown-worker"]);
  });

  it("returns configured: false when the database read fails", async () => {
    const { probeCronFreshness } = await importer();
    mockError = { message: "db unavailable" };
    const r = await probeCronFreshness();
    expect(r.configured).toBe(false);
    expect(r.workers).toEqual([]);
  });
});

describe("emitStaleCronAlert", () => {
  it("logs CRITICAL when cron/tick is stale", async () => {
    const { emitStaleCronAlert } = await importer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = emitStaleCronAlert({
      any_stale: true,
      tick_stale: true,
      daily_stale: false,
      stale_workers: ["cron/tick"],
    });
    expect(r.fired).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[CRITICAL] cron/tick is stale"));
    spy.mockRestore();
  });

  it("logs a WARN for sub-handlers when only they are stale", async () => {
    const { emitStaleCronAlert } = await importer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = emitStaleCronAlert({
      any_stale: true,
      tick_stale: false,
      daily_stale: false,
      stale_workers: ["netsuite/sync"],
    });
    expect(r.fired).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[WARN] netsuite/sync"));
    spy.mockRestore();
  });

  it("returns null and emits nothing when no worker is stale", async () => {
    const { emitStaleCronAlert } = await importer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = emitStaleCronAlert({ any_stale: false, stale_workers: [] });
    expect(r).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
