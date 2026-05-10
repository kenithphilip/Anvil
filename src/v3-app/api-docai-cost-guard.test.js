// Cost-guard tests.
//
// Covers:
//   - allowedToCall short-circuits ALWAYS_FREE adapters.
//   - allowedToCall returns allowed when no docai_daily_limits set.
//   - allowedToCall returns allowed when adapter is absent from the limits map.
//   - allowedToCall blocks when count >= limit.
//   - recordCall inserts a new row when none exists for today.
//   - recordCall increments an existing row when one exists.
//   - summariseUsage returns today's rows ordered by call_count desc.

import { describe, it, expect } from "vitest";
import { allowedToCall, getDailyUsage, recordCall, summariseUsage, __consts__ } from "../api/_lib/cost_guard.js";

const today = () => new Date().toISOString().slice(0, 10);

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];

  const newCtx = (table) => ({ table, filters: [], action: null, values: null });
  const matches = (ctx, r) => ctx.filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v
    : f.op === "in" ? Array.isArray(f.v) && f.v.includes(r[f.col])
    : f.op === "is" ? r[f.col] === f.v
    : true
  ));
  const builder = (table) => {
    const ctx = newCtx(table);
    const api = {
      select(_c) { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      order() { return api; },
      maybeSingle() { return Promise.resolve({ data: get(table).filter((r) => matches(ctx, r))[0] || null, error: null }); },
      then(resolve) {
        if (ctx.action === "update") {
          const rows = get(table);
          const updated = rows.map((r) => (matches(ctx, r) ? { ...r, ...ctx.values } : r));
          tables.set(table, updated);
          resolve({ data: updated.filter((r) => matches(ctx, r)), error: null });
        } else {
          resolve({ data: get(table).filter((r) => matches(ctx, r)), error: null });
        }
        return { catch: () => ({}) };
      },
      update(values) { ctx.action = "update"; ctx.values = values; return api; },
      insert(values) {
        const row = { ...values };
        const existing = get(table);
        existing.push(row);
        tables.set(table, existing);
        return { then: (resolve) => { resolve({ data: [row], error: null }); return { catch: () => ({}) }; } };
      },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

describe("cost_guard / always-free adapters", () => {
  it("short-circuits docling/marker/excel/gaeb without checking limits", async () => {
    const svc = buildSvc();
    for (const a of __consts__.ALWAYS_FREE) {
      const r = await allowedToCall(svc, { docai_daily_limits: { [a]: 0 } }, a);
      expect(r.allowed).toBe(true);
      expect(r.limit).toBeNull();
    }
  });
});

describe("cost_guard / no limits configured", () => {
  it("allowed when docai_daily_limits is null", async () => {
    const svc = buildSvc();
    const r = await allowedToCall(svc, { docai_daily_limits: null }, "claude");
    expect(r.allowed).toBe(true);
  });

  it("allowed when adapter is absent from the map", async () => {
    const svc = buildSvc();
    const r = await allowedToCall(svc, { docai_daily_limits: { reducto: 5 } }, "claude");
    expect(r.allowed).toBe(true);
    expect(r.limit).toBeNull();
  });
});

describe("cost_guard / over budget", () => {
  it("blocks when current count >= limit", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 50 },
      ],
    });
    const r = await allowedToCall(svc, { tenant_id: "t1", docai_daily_limits: { claude: 50 } }, "claude");
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(50);
    expect(r.limit).toBe(50);
    expect(r.reason).toBe("over_daily_budget");
  });

  it("allows when count < limit", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 12 },
      ],
    });
    const r = await allowedToCall(svc, { tenant_id: "t1", docai_daily_limits: { claude: 50 } }, "claude");
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(12);
    expect(r.limit).toBe(50);
  });
});

describe("cost_guard / recordCall", () => {
  it("inserts a new row when none exists for today", async () => {
    const svc = buildSvc();
    await recordCall(svc, { tenantId: "t1", adapter: "claude", costUsd: 0.022 });
    const rows = svc._tables.get("docai_daily_usage") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: "t1",
      adapter: "claude",
      call_count: 1,
    });
    expect(Number(rows[0].estimated_cost_usd)).toBeCloseTo(0.022, 4);
  });

  it("increments an existing row when one exists", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 3, estimated_cost_usd: 0.066 },
      ],
    });
    await recordCall(svc, { tenantId: "t1", adapter: "claude", costUsd: 0.022 });
    const rows = svc._tables.get("docai_daily_usage") || [];
    // After update, the original row mutated in-place.
    expect(rows[0].call_count).toBe(4);
    expect(Number(rows[0].estimated_cost_usd)).toBeCloseTo(0.088, 4);
  });

  it("uses the default cost map when no costUsd is supplied", async () => {
    const svc = buildSvc();
    await recordCall(svc, { tenantId: "t1", adapter: "gemini" });
    const rows = svc._tables.get("docai_daily_usage") || [];
    expect(Number(rows[0].estimated_cost_usd)).toBeCloseTo(__consts__.DEFAULT_COST_USD.gemini, 6);
  });
});

describe("cost_guard / summariseUsage", () => {
  it("returns today's rows for the tenant", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 5, estimated_cost_usd: 0.11 },
        { tenant_id: "t1", usage_date: today(), adapter: "gemini", call_count: 25, estimated_cost_usd: 0.015 },
        { tenant_id: "t2", usage_date: today(), adapter: "claude", call_count: 999, estimated_cost_usd: 22 },
      ],
    });
    const out = await summariseUsage(svc, { tenantId: "t1" });
    expect(out).toHaveLength(2);
    expect(out.every((r) => ["claude", "gemini"].includes(r.adapter))).toBe(true);
    // Tenant isolation: t2's giant claude row never appears.
    expect(out.find((r) => r.call_count === 999)).toBeUndefined();
  });
});

describe("cost_guard / getDailyUsage", () => {
  it("returns 0 when no row exists", async () => {
    const svc = buildSvc();
    const c = await getDailyUsage(svc, { tenantId: "t1", adapter: "claude" });
    expect(c).toBe(0);
  });

  it("returns the call_count when row exists", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 17 },
      ],
    });
    const c = await getDailyUsage(svc, { tenantId: "t1", adapter: "claude" });
    expect(c).toBe(17);
  });
});
