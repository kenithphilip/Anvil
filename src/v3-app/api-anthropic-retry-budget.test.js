// Guards the run-budget guards added to callAnthropic's retry loop after a real
// PO failure: Claude 5xx'd, its retries (with an UNCAPPED Retry-After sleep) ate
// the whole 45s run budget, and Gemini/LlamaParse were then skipped
// run_budget_exhausted. capRetrySleep + attemptTimeout are the pure decision
// functions; deadlineAt=0 must reproduce the historical behaviour exactly.

import { describe, it, expect } from "vitest";
import { capRetrySleep, attemptTimeout } from "../api/_lib/anthropic.js";

describe("capRetrySleep", () => {
  it("caps an (uncapped) Retry-After sleep — the actual bug", () => {
    // 30s Retry-After from a 529 must not sleep 30s.
    expect(capRetrySleep(30_000, { maxSleepMs: 8000 })).toBe(8000);
  });
  it("with no deadline, returns the (capped) backoff and never null", () => {
    expect(capRetrySleep(600, { maxSleepMs: 8000 })).toBe(600);
    expect(capRetrySleep(1200, { maxSleepMs: 8000 })).toBe(1200);
    expect(capRetrySleep(99_000, { maxSleepMs: 8000 })).toBe(8000);
  });
  it("with plenty of budget, still allows the retry", () => {
    // 45s budget, at t=0, 8s reserve -> 37s left > 8s wait.
    expect(capRetrySleep(8000, { deadlineAt: 45_000, now: 0, reserveMs: 8000, maxSleepMs: 8000 })).toBe(8000);
  });
  it("refuses to retry when sleeping would eat the fallback reserve", () => {
    // Only 2s of budget beyond the reserve; an 8s sleep would starve the fallback.
    expect(capRetrySleep(8000, { deadlineAt: 10_000, now: 0, reserveMs: 8000, maxSleepMs: 8000 })).toBe(null);
  });
  it("still allows a short backoff when it fits inside the remaining budget", () => {
    // 2s beyond reserve, 600ms backoff fits.
    expect(capRetrySleep(600, { deadlineAt: 10_000, now: 0, reserveMs: 8000, maxSleepMs: 8000 })).toBe(600);
  });
});

describe("attemptTimeout", () => {
  it("with no deadline returns the ceiling (historical behaviour)", () => {
    expect(attemptTimeout({ ceilingMs: 15_000 })).toBe(15_000);
  });
  it("with a fresh budget is capped at the ceiling", () => {
    expect(attemptTimeout({ deadlineAt: 45_000, now: 0, reserveMs: 8000, ceilingMs: 15_000 })).toBe(15_000);
  });
  it("shrinks to the remaining budget minus the reserve as the deadline nears", () => {
    expect(attemptTimeout({ deadlineAt: 10_000, now: 0, reserveMs: 8000, ceilingMs: 15_000 })).toBe(2000);
  });
  it("floors at 0 once the reserve is already spent (caller then skips the call)", () => {
    expect(attemptTimeout({ deadlineAt: 5000, now: 0, reserveMs: 8000, ceilingMs: 15_000 })).toBe(0);
  });
});
