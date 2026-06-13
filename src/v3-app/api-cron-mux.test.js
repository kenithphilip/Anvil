// Unit tests for the cron multiplexer helpers.
//
// We test:
//   - shouldRunOnMinute correctly gates by minute % every.
//   - The mock req carries the auth header.
//   - The mock res supports the chained .status().json() / .send() /
//     .setHeader() patterns used by every cron handler.
//   - runCronHandler captures status + body without throwing on
//     handler errors.
//   - runCronGroup runs all handlers even when some throw.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  makeMockReq, makeMockRes, runCronHandler, runCronGroup, shouldRunOnMinute,
  cronHandlerBudgetMs,
} from "../api/_lib/cron-mux.js";

beforeAll(() => { process.env.CRON_SECRET = "test-secret-1234"; });
afterAll(() => { delete process.env.CRON_SECRET; });

describe("cron-mux / shouldRunOnMinute", () => {
  it("returns true when minute % every === 0", () => {
    expect(shouldRunOnMinute(0, 30)).toBe(true);
    expect(shouldRunOnMinute(30, 30)).toBe(true);
    expect(shouldRunOnMinute(0, 60)).toBe(true);
  });
  it("returns false when minute % every !== 0", () => {
    expect(shouldRunOnMinute(5, 30)).toBe(false);
    expect(shouldRunOnMinute(15, 30)).toBe(false);
    expect(shouldRunOnMinute(45, 60)).toBe(false);
  });
  it("returns false on bad input", () => {
    expect(shouldRunOnMinute(0, 0)).toBe(false);
    expect(shouldRunOnMinute(0, -1)).toBe(false);
    expect(shouldRunOnMinute(0, NaN)).toBe(false);
  });
});

describe("cron-mux / mock req", () => {
  it("carries the cron secret in the authorization header", () => {
    const req = makeMockReq({ path: "/api/x" });
    expect(req.headers.authorization).toBe("Bearer test-secret-1234");
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/x");
  });
  it("on() is a no-op (no body events for cron paths)", () => {
    const req = makeMockReq();
    expect(typeof req.on).toBe("function");
    expect(() => req.on("data", () => {})).not.toThrow();
  });
});

describe("cron-mux / mock res", () => {
  it("captures res.status(n).json(body)", () => {
    const { res, _outcome } = makeMockRes();
    res.status(200).json({ ok: true });
    expect(_outcome.statusCode).toBe(200);
    expect(_outcome.body).toBe('{"ok":true}');
    expect(_outcome.headers["Content-Type"]).toBe("application/json");
  });
  it("captures res.status(n).send(string)", () => {
    const { res, _outcome } = makeMockRes();
    res.status(204).send("hello");
    expect(_outcome.statusCode).toBe(204);
    expect(_outcome.body).toBe("hello");
  });
  it("captures res.setHeader chains", () => {
    const { res, _outcome } = makeMockRes();
    res.setHeader("X-Custom", "v1");
    res.setHeader("X-Other", "v2");
    expect(_outcome.headers["X-Custom"]).toBe("v1");
    expect(_outcome.headers["X-Other"]).toBe("v2");
  });
  it("res.end with body sets body and 200 by default", () => {
    const { res, _outcome } = makeMockRes();
    res.end("done");
    expect(_outcome.statusCode).toBe(200);
    expect(_outcome.body).toBe("done");
  });
});

describe("cron-mux / runCronHandler", () => {
  it("captures a successful handler", async () => {
    const fakeHandler = async (req, res) => {
      expect(req.headers.authorization).toContain("Bearer ");
      res.status(200).json({ processed: 3 });
    };
    const r = await runCronHandler("fake/ok", fakeHandler, { path: "/api/fake/ok" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body_preview).toContain("processed");
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
  it("captures a non-2xx handler as failed", async () => {
    const fakeHandler = async (req, res) => { res.status(409).json({ error: "conflict" }); };
    const r = await runCronHandler("fake/409", fakeHandler);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
  it("does not throw when the handler throws synchronously", async () => {
    const fakeHandler = async () => { throw new Error("boom"); };
    const r = await runCronHandler("fake/boom", fakeHandler);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });
  it("does not throw on a rejected promise", async () => {
    const fakeHandler = () => Promise.reject(new Error("async-boom"));
    const r = await runCronHandler("fake/reject", fakeHandler);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("async-boom");
  });
});

describe("cron-mux / per-handler timeout (Phase 1 F10)", () => {
  it("times out a hanging handler within the budget", async () => {
    const stuck = () => new Promise(() => { /* never resolves */ });
    const r = await runCronHandler("fake/hang", stuck, { timeoutMs: 30, writeHeartbeat: false });
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.error).toBe("timeout");
    expect(r.status).toBe(504);
    expect(r.budget_ms).toBe(30);
    // The handler hangs forever, so it must have run ~to the budget
    // (not to completion). Allow a few ms of timer/measurement jitter
    // below the budget — the exact-budget assertion flaked in CI
    // ("expected 29 to be >= 30"). The timeout itself is already proven
    // by timed_out / status 504 / budget_ms above.
    expect(r.duration_ms).toBeGreaterThanOrEqual(25);
  });

  it("does not time out a fast handler", async () => {
    const fast = async (_req, res) => { res.status(200).json({ ok: true }); };
    const r = await runCronHandler("fake/fast", fast, { timeoutMs: 500, writeHeartbeat: false });
    expect(r.ok).toBe(true);
    expect(r.timed_out).toBeFalsy();
    expect(r.budget_ms).toBe(500);
  });

  it("picks the budget by handler-name prefix when timeoutMs is unset", () => {
    expect(cronHandlerBudgetMs("sap/sync")).toBe(25000);
    expect(cronHandlerBudgetMs("tally/retry")).toBe(30000);
    expect(cronHandlerBudgetMs("p21/retry")).toBe(15000);
    expect(cronHandlerBudgetMs("nonexistent/whatever")).toBe(20000); // default
  });
});

describe("cron-mux / runCronGroup", () => {
  it("runs every handler even when some fail", async () => {
    const ok1 = async (_req, res) => res.status(200).json({ a: 1 });
    const fail = async () => { throw new Error("nope"); };
    const ok2 = async (_req, res) => res.status(200).json({ b: 2 });
    const results = await runCronGroup([
      { name: "ok1", fn: ok1 },
      { name: "fail", fn: fail },
      { name: "ok2", fn: ok2 },
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual(["ok1", "fail", "ok2"]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
  });
});
