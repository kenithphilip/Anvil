// Gemini and LlamaParse were the last two upstream calls with no run-budget
// awareness, which is how a run gets stranded at status='running' forever:
//
//   - callGemini passed a flat timeoutMs: 60_000, looped 3 attempts, and slept
//     on an UNCAPPED retry-after header. Worst case ran far past docai's 45s
//     RUN_BUDGET_MS and past vercel.json's maxDuration of 60, so the platform
//     killed the function mid-flight and run.js never wrote its final UPDATE.
//     Gemini is FIRST in the default provider order, so it is the likeliest
//     adapter to strand a run.
//   - LlamaParse's SDK parse() polls internally and exposes no timeout at all.
//
// PR #394 fixed exactly this for Anthropic; these guards port it to the other
// two. deadlineAt=0 (every non-docai caller) must reproduce the old behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attemptTimeout, capRetrySleep } from "../api/_lib/anthropic.js";
import { parseBudgetMs } from "../api/_lib/docai/llamaparse.js";

// The ceiling callGemini passes to attemptTimeout (GEMINI_TIMEOUT_MS default).
const GEMINI_CEILING = 60_000;
const RESERVE = 8000;

describe("callGemini attempt budgeting", () => {
  it("with no deadline uses the full 60s ceiling (historical behaviour)", () => {
    expect(attemptTimeout({ ceilingMs: GEMINI_CEILING })).toBe(GEMINI_CEILING);
  });

  it("never exceeds what is left of the 45s run budget", () => {
    // t=0 into a 45s budget: 45000 - 0 - 8000 = 37000, well under the 60s
    // ceiling. Previously this call was allowed a flat 60s — longer than the
    // entire run budget AND equal to the whole function ceiling.
    const t = attemptTimeout({ deadlineAt: 45_000, now: 0, reserveMs: RESERVE, ceilingMs: GEMINI_CEILING });
    expect(t).toBe(37_000);
    expect(t).toBeLessThan(45_000);
  });

  it("shrinks as the deadline nears", () => {
    expect(attemptTimeout({ deadlineAt: 45_000, now: 30_000, reserveMs: RESERVE, ceilingMs: GEMINI_CEILING })).toBe(7000);
  });

  it("floors at 0 once the reserve is spent, so the caller skips the call", () => {
    // Below MIN_ATTEMPT_MS (2000) callGemini breaks out instead of starting a
    // request it cannot finish — starting one is what strands the run.
    const t = attemptTimeout({ deadlineAt: 45_000, now: 44_000, reserveMs: RESERVE, ceilingMs: GEMINI_CEILING });
    expect(t).toBe(0);
    expect(t).toBeLessThan(2000);
  });

  it("caps an uncapped retry-after sleep", () => {
    // A 429 with "Retry-After: 30" previously slept the full 30s.
    expect(capRetrySleep(30_000, { deadlineAt: 0, maxSleepMs: 8000 })).toBe(8000);
  });

  it("refuses a retry that would eat the downstream reserve", () => {
    expect(capRetrySleep(8000, { deadlineAt: 10_000, now: 0, reserveMs: RESERVE, maxSleepMs: 8000 })).toBe(null);
  });
});

describe("llamaparse parseBudgetMs", () => {
  it("with no deadline returns the standalone ceiling", () => {
    expect(parseBudgetMs(0, 0, 45_000)).toBe(45_000);
  });

  it("bounds the SDK call by the remaining run budget", () => {
    // 2s reserve so the dispatcher can still record the attempt.
    expect(parseBudgetMs(45_000, 10_000, 45_000)).toBe(33_000);
  });

  it("never returns negative once the budget is blown", () => {
    expect(parseBudgetMs(45_000, 60_000, 45_000)).toBe(0);
  });
});

describe("callGemini passes the deadline through without changing old callers", () => {
  const saved = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  const loadWithFetchSpy = async (fetchImpl) => {
    vi.doMock("../api/_lib/safe-fetch.js", () => ({ safeFetch: fetchImpl }));
    return (await import("../api/_lib/gemini.js")).callGemini;
  };

  const okResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
  });

  it("omitting deadlineAt still sends the full 60s timeout", async () => {
    const safeFetch = vi.fn(async () => okResponse());
    const callGemini = await loadWithFetchSpy(safeFetch);
    await callGemini({ tenantId: "t1", apiKey: "k", messages: [{ role: "user", content: "hi" }] });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][1].timeoutMs).toBe(60_000);
  });

  it("a near deadline shrinks the timeout below the ceiling", async () => {
    const safeFetch = vi.fn(async () => okResponse());
    const callGemini = await loadWithFetchSpy(safeFetch);
    await callGemini({
      tenantId: "t1", apiKey: "k", messages: [{ role: "user", content: "hi" }],
      deadlineAt: Date.now() + 20_000,
    });
    const sent = safeFetch.mock.calls[0][1].timeoutMs;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(12_000); // 20s - 8s reserve
  });

  it("refuses to start a call it cannot finish, instead of stranding the run", async () => {
    const safeFetch = vi.fn(async () => okResponse());
    const callGemini = await loadWithFetchSpy(safeFetch);
    const out = await callGemini({
      tenantId: "t1", apiKey: "k", messages: [{ role: "user", content: "hi" }],
      deadlineAt: Date.now() + 1000, // under the 8s reserve -> no budget at all
    });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toContain("run budget exhausted");
  });
});
