// Handler tests for src/api/docai/review_queue.js (Wave 4.1 operator
// surface). The lib functions are unit-tested in
// api-docai-review-queue.test.js; here we assert the HTTP handler:
//   - GET returns { queue, summary } and defaults to open + in_review
//   - POST claim   -> in_review + assigned to caller
//   - POST resolve -> resolved + resolution + resolved_by
//   - POST resolve without a resolution -> 400
//   - POST with a bad / missing action -> 400

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queueRows: [],
  summaryRows: [],
  updateCalls: [],
  updateResult: { ok: true },
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
}));

vi.mock("../api/_lib/docai/review-queue.js", () => ({
  updateReviewStatus: vi.fn(async (svc, args) => {
    h.updateCalls.push(args);
    return h.updateResult;
  }),
}));

// Supabase shim. The list query is awaited directly, so the query
// object is thenable and resolves to { data, error } keyed off whether
// .in("status", ...) selected the open backlog (summary query selects
// only "severity"). We distinguish the two by the selected columns.
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({
    from: () => {
      const q = {
        _select: "",
        select(cols) { this._select = cols || ""; return this; },
        eq() { return this; },
        in() { return this; },
        order() { return this; },
        limit() { return this; },
        then(resolve) {
          // The summary query selects just "severity"; the main list
          // query selects the full column set.
          const isSummary = this._select.trim() === "severity";
          resolve({ data: isSummary ? h.summaryRows : h.queueRows, error: null });
        },
      };
      return q;
    },
  })),
}));

const { default: handler } = await import("../api/docai/review_queue.js");

const makeRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; },
  send(payload) { this.body = payload; return this; },
  json(obj) { this.body = JSON.stringify(obj); return this; },
  end() { return this; },
});

const run = async (req) => {
  const res = makeRes();
  await handler(req, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = res.body; }
  return { res, parsed };
};

beforeEach(() => {
  h.queueRows = [
    { id: "q1", reason: "low_confidence", severity: "high", status: "open" },
    { id: "q2", reason: "anomalies", severity: "critical", status: "in_review" },
  ];
  h.summaryRows = [{ severity: "high" }, { severity: "critical" }, { severity: "critical" }];
  h.updateCalls = [];
  h.updateResult = { ok: true };
});

describe("GET /api/docai/review_queue", () => {
  it("returns the queue plus a severity summary", async () => {
    const { res, parsed } = await run({ method: "GET", headers: {}, url: "/api/docai/review_queue" });
    expect(res.statusCode).toBe(200);
    expect(parsed.queue).toHaveLength(2);
    expect(parsed.summary).toMatchObject({ high: 1, critical: 2, total: 3 });
  });
});

describe("POST /api/docai/review_queue", () => {
  it("claim moves the row to in_review and assigns the caller", async () => {
    const { res } = await run({ method: "POST", headers: {}, body: { id: "q1", action: "claim" } });
    expect(res.statusCode).toBe(200);
    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]).toMatchObject({ queueId: "q1", status: "in_review", assignedTo: "u-1" });
  });

  it("resolve closes the row with a resolution + resolver", async () => {
    const { res } = await run({
      method: "POST", headers: {},
      body: { id: "q1", action: "resolve", resolution: "confirmed", notes: "looks good" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updateCalls[0]).toMatchObject({
      queueId: "q1", status: "resolved", resolution: "confirmed", resolvedBy: "u-1", notes: "looks good",
    });
  });

  it("reopen returns the row to open and clears the assignee", async () => {
    const { res } = await run({ method: "POST", headers: {}, body: { id: "q1", action: "reopen" } });
    expect(res.statusCode).toBe(200);
    expect(h.updateCalls[0]).toMatchObject({ queueId: "q1", status: "open", assignedTo: null });
  });

  it("rejects resolve without a valid resolution", async () => {
    const { res, parsed } = await run({ method: "POST", headers: {}, body: { id: "q1", action: "resolve" } });
    expect(res.statusCode).toBe(400);
    expect(parsed.error.message).toMatch(/resolution/);
    expect(h.updateCalls).toHaveLength(0);
  });

  it("rejects an unknown action", async () => {
    const { res } = await run({ method: "POST", headers: {}, body: { id: "q1", action: "nuke" } });
    expect(res.statusCode).toBe(400);
    expect(h.updateCalls).toHaveLength(0);
  });

  it("requires id and action", async () => {
    const { res } = await run({ method: "POST", headers: {}, body: { id: "q1" } });
    expect(res.statusCode).toBe(400);
  });
});
