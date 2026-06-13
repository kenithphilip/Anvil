// Handler test for src/api/analytics/funnel.js — reads
// analytics_funnel_daily into the cockpit-ready shape (latest per-stage
// snapshot + window entered/exited + ordered stages).

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ rows: [] }));
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })), requirePermission: vi.fn(() => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, then: (resolve) => resolve({ data: H.rows, error: null }) };
      return q;
    },
  }),
}));
const { default: handler } = await import("../api/analytics/funnel.js");

const run = async () => {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = JSON.stringify(o); return this; }, send(p) { this.body = p; return this; }, end() { return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/analytics/funnel" }, res);
  return JSON.parse(res.body);
};

beforeEach(() => {
  H.rows = [
    { day: "2026-06-01", stage: "QUALIFICATION", entered: 3, exited: 1, count_in_stage: null, value_in_stage: null, weighted_value_in_stage: null, median_age_days: null },
    { day: "2026-06-02", stage: "QUALIFICATION", entered: 2, exited: 0, count_in_stage: 10, value_in_stage: 100000, weighted_value_in_stage: 5000, median_age_days: 4 },
    { day: "2026-06-02", stage: "RFQ", entered: 1, exited: 0, count_in_stage: 4, value_in_stage: 80000, weighted_value_in_stage: 24000, median_age_days: 7 },
  ];
});

describe("GET /api/analytics/funnel", () => {
  it("returns latest per-stage snapshot + summed flow, ordered", async () => {
    const out = await run();
    expect(out.as_of).toBe("2026-06-02");
    expect(out.stages.map((s) => s.stage)).toEqual(["QUALIFICATION", "RFQ"]); // canonical order
    const qual = out.stages.find((s) => s.stage === "QUALIFICATION");
    expect(qual).toMatchObject({ entered: 5, exited: 1, count_in_stage: 10, value_in_stage: 100000, median_age_days: 4 });
    expect(out.totals).toMatchObject({ count_in_stage: 14, value_in_stage: 180000, weighted_value_in_stage: 29000 });
  });
});
