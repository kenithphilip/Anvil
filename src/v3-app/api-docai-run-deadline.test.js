// Run budget + stale-run reaper.
//
// run.js inserts extraction_runs as status='running' and writes the terminal
// status only in its FINAL update. So when the serverless function is killed
// at its ceiling (vercel.json pins api/dispatch.js to maxDuration 60 — the cap
// on the current plan) the row is never finalised: no attempts, no error, no
// finished_at. It stays 'running' for ever and the workspace spins.
//
// Two runs on PO 0066026562 were stranded exactly this way once the text-layer
// fix pushed Claude onto the slower generation tier (a 47s call in a 60s box).
//
// Two defences, tested here:
//   1. dispatchExtract refuses to START an adapter past the deadline.
//   2. reapStaleRuns finalises anything that slipped through anyway.

import { describe, it, expect, vi, beforeEach } from "vitest";

const chainable = () => {
  const api = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
      return () => api;
    },
  });
  return api;
};

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => chainable() }));
vi.mock("../api/_lib/docai/adapter-learning.js", () => ({
  rankAdaptersForCustomer: async ({ order }) => order,
}));
vi.mock("../api/_lib/docai/pdf-metadata.js", () => ({
  readPdfBias: async () => null,
  composeOrderWithBias: (order) => order,
}));
vi.mock("../api/_lib/docai/unstructured.js", () => ({
  isConfigured: () => true,
  extract: vi.fn(async () => ({
    ok: true,
    normalized: { classification: "po", customer: { name: "Acme" }, lines: [{ partNumber: "X", quantity: 1 }] },
    confidences: { overall: 0.95 },
  })),
}));

import { dispatchExtract } from "../api/_lib/docai/index.js";
import * as unstructured from "../api/_lib/docai/unstructured.js";
import { reapStaleRuns } from "../api/_lib/docai/reap-stale-runs.js";

const source = { bytes: Buffer.from("%PDF-1.4 x"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" };
const settings = { tenant_id: "t1", docai_provider_order: ["unstructured"] };

describe("run deadline stops the chain before the function is killed", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("does not START an adapter once the budget is spent", async () => {
    const out = await dispatchExtract({
      source, settings, customerId: null,
      hints: { deadlineAt: Date.now() - 1 },   // already expired
    });
    const attempt = (out.attempts || []).find((a) => a.adapter === "unstructured");
    expect(attempt.status).toBe("skipped_deadline");
    expect(attempt.reason).toBe("run_budget_exhausted");
    // The point: no provider call is made, so nothing is billed for work the
    // platform would kill mid-flight.
    expect(unstructured.extract).not.toHaveBeenCalled();
  });

  it("runs normally when there is budget left", async () => {
    const out = await dispatchExtract({
      source, settings, customerId: null,
      hints: { deadlineAt: Date.now() + 60_000 },
    });
    expect(unstructured.extract).toHaveBeenCalledTimes(1);
    expect((out.attempts || []).find((a) => a.adapter === "unstructured").status).toBe("ok");
  });

  it("is inert when no deadline is supplied (callers that never set one)", async () => {
    const out = await dispatchExtract({ source, settings, customerId: null, hints: {} });
    expect(unstructured.extract).toHaveBeenCalledTimes(1);
    expect((out.attempts || []).find((a) => a.adapter === "unstructured").status).toBe("ok");
  });
});

describe("reapStaleRuns", () => {
  // Minimal query recorder: captures the filter chain so we can assert the
  // reaper only ever touches OLD rows that are still 'running'.
  const makeSvc = (rows) => {
    const calls = { update: null, filters: [], table: null };
    const q = {
      update(patch) { calls.update = patch; return q; },
      eq(c, v) { calls.filters.push(["eq", c, v]); return q; },
      lt(c, v) { calls.filters.push(["lt", c, v]); return q; },
      select() { return Promise.resolve({ data: rows, error: null }); },
    };
    return { calls, from(t) { calls.table = t; return q; } };
  };

  it("marks stale running rows failed with a diagnosable reason", async () => {
    const svc = makeSvc([{ id: "r1" }, { id: "r2" }]);
    const out = await reapStaleRuns(svc, { tenantId: "t1" });
    expect(out.reaped).toBe(2);
    expect(out.ids).toEqual(["r1", "r2"]);
    expect(svc.calls.table).toBe("extraction_runs");
    expect(svc.calls.update.status).toBe("failed");
    expect(svc.calls.update.status_reason).toBe("timed_out");
    expect(svc.calls.update.finished_at).toBeTruthy();
    expect(svc.calls.update.error).toMatch(/ceiling/i);
  });

  it("only targets status=running rows older than the cutoff", async () => {
    const svc = makeSvc([]);
    await reapStaleRuns(svc, { tenantId: "t1", staleMinutes: 5 });
    const eqs = svc.calls.filters.filter((f) => f[0] === "eq");
    const lts = svc.calls.filters.filter((f) => f[0] === "lt");
    expect(eqs).toContainEqual(["eq", "status", "running"]);
    expect(eqs).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(lts[0][1]).toBe("started_at");
    // A genuinely in-flight run must never be reaped, so the cutoff has to sit
    // comfortably beyond the 60s function ceiling.
    expect(Date.now() - new Date(lts[0][2]).getTime()).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
  });

  it("sweeps every tenant when no tenantId is given (the cron path)", async () => {
    const svc = makeSvc([]);
    await reapStaleRuns(svc);
    expect(svc.calls.filters.some((f) => f[1] === "tenant_id")).toBe(false);
  });

  it("never throws on a broken client", async () => {
    await expect(reapStaleRuns(null)).resolves.toEqual({ reaped: 0, ids: [] });
    const boom = { from() { throw new Error("db down"); } };
    await expect(reapStaleRuns(boom)).resolves.toEqual({ reaped: 0, ids: [] });
  });
});
