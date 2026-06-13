// Unit tests for src/api/_lib/funnel-analytics.js — the sales-ops
// funnel data layer (stage-event capture + daily aggregation).

import { describe, it, expect } from "vitest";
import { recordStageEvent, refreshFunnel, __test__ } from "../api/_lib/funnel-analytics.js";

// Minimal supabase shim. Each table has a FIFO queue of {data,error}
// responses consumed by maybeSingle()/await; insert()/upsert() are
// captured for assertions.
const makeSvc = (responses = {}) => {
  const inserts = [];
  const upserts = [];
  const shift = (table) => {
    const arr = responses[table] || [];
    return arr.length ? arr.shift() : { data: null, error: null };
  };
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, not: () => b,
      in: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve(shift(table)),
      insert: (row) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      upsert: (row, opts) => { upserts.push({ table, row, opts }); return Promise.resolve({ error: null }); },
      then: (resolve, reject) => Promise.resolve(shift(table)).then(resolve, reject),
    };
    return b;
  };
  return { svc: { from }, inserts, upserts };
};

describe("helpers", () => {
  it("median handles even/odd/empty", () => {
    expect(__test__.median([])).toBeNull();
    expect(__test__.median([3, 1, 2])).toBe(2);
    expect(__test__.median([1, 2, 3, 4])).toBe(2.5);
  });
  it("percentile is nearest-rank", () => {
    expect(__test__.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(__test__.percentile([], 90)).toBeNull();
  });
});

describe("recordStageEvent", () => {
  it("inserts a row and computes dwell from the prior event", async () => {
    const { svc, inserts } = makeSvc({
      opportunity_stage_events: [{ data: { changed_at: "2026-05-01T00:00:00.000Z" }, error: null }],
    });
    const out = await recordStageEvent(svc, {
      tenantId: "t1", opportunityId: "o1",
      fromStage: "QUALIFICATION", toStage: "RFQ",
      changedBy: "u1", ownerId: "u9", amountInr: 1000, probability: 30,
      changedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(out.ok).toBe(true);
    expect(out.days_in_from_stage).toBe(10);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({
      tenant_id: "t1", opportunity_id: "o1",
      from_stage: "QUALIFICATION", to_stage: "RFQ",
      changed_by: "u1", owner_id: "u9", amount_inr: 1000, probability: 30,
      days_in_from_stage: 10, source: "live",
    });
  });

  it("falls back to opp.created_at when there's no prior event", async () => {
    const { svc, inserts } = makeSvc({
      opportunity_stage_events: [{ data: null, error: null }],     // no prior event
      opportunities: [{ data: { created_at: "2026-05-09T00:00:00.000Z" }, error: null }],
    });
    const out = await recordStageEvent(svc, {
      tenantId: "t1", opportunityId: "o1", fromStage: null, toStage: "QUALIFICATION",
      changedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(out.days_in_from_stage).toBe(2);
    expect(inserts[0].row.from_stage).toBeNull();
  });

  it("rejects missing args", async () => {
    const { svc } = makeSvc();
    expect((await recordStageEvent(svc, { tenantId: "t" })).ok).toBe(false);
  });
});

describe("refreshFunnel", () => {
  it("buckets entered/exited per day+stage and snapshots today's open funnel", async () => {
    const events = [
      { from_stage: null, to_stage: "QUALIFICATION", changed_at: "2026-05-10T09:00:00.000Z" },
      { from_stage: "QUALIFICATION", to_stage: "RFQ", changed_at: "2026-05-11T09:00:00.000Z" },
    ];
    const opps = [
      { id: "o1", stage: "RFQ", amount_inr: 1000, probability: 30, created_at: "2026-05-01T00:00:00.000Z" },
      { id: "o2", stage: "QUALIFICATION", amount_inr: 500, probability: 10, created_at: "2026-05-05T00:00:00.000Z" },
    ];
    const latest = [
      { opportunity_id: "o1", changed_at: "2026-05-11T00:00:00.000Z" },
      { opportunity_id: "o2", changed_at: "2026-05-10T00:00:00.000Z" },
    ];
    const { svc, upserts } = makeSvc({
      // refreshFunnel awaits: window events, then opps, then latest events.
      opportunity_stage_events: [{ data: events, error: null }, { data: latest, error: null }],
      opportunities: [{ data: opps, error: null }],
    });

    const out = await refreshFunnel(svc, "t1", { sinceDays: 90, today: "2026-05-12T00:00:00.000Z" });
    expect(out.stages_snapshotted).toBe(2);

    const find = (day, stage) =>
      upserts.map((u) => u.row).find((r) => r.day === day && r.stage === stage);

    // Flow rows (entered/exited), no snapshot cols.
    expect(find("2026-05-10", "QUALIFICATION")).toMatchObject({ entered: 1, exited: 0 });
    expect(find("2026-05-11", "RFQ")).toMatchObject({ entered: 1, exited: 0 });
    expect(find("2026-05-11", "QUALIFICATION")).toMatchObject({ entered: 0, exited: 1 });

    // Today's snapshot rows (count/value/weighted/age), no entered/exited.
    const snapRFQ = find("2026-05-12", "RFQ");
    expect(snapRFQ).toMatchObject({ count_in_stage: 1, value_in_stage: 1000, weighted_value_in_stage: 300 });
    expect(snapRFQ.median_age_days).toBe(1);          // 05-12 minus 05-11
    expect(snapRFQ.entered).toBeUndefined();          // snapshot upsert omits flow cols

    const snapQual = find("2026-05-12", "QUALIFICATION");
    expect(snapQual).toMatchObject({ count_in_stage: 1, value_in_stage: 500, weighted_value_in_stage: 50 });
    expect(snapQual.median_age_days).toBe(2);         // 05-12 minus 05-10

    // All upserts target analytics_funnel_daily with the right conflict key.
    for (const u of upserts) {
      expect(u.table).toBe("analytics_funnel_daily");
      expect(u.opts.onConflict).toBe("tenant_id,day,stage");
    }
  });
});
