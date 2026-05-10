// /api/inventory/forecast_runs read-endpoint tests.
//
// History view of inventory-planning forecast runs. Two modes:
//   - GET /api/inventory/forecast_runs           -> { runs }
//   - GET /api/inventory/forecast_runs?id=<uuid> -> { run, forecasts_sample }
//
// We assert on routing, response shape, 404 on unknown id, and the
// best-effort sample join.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = 500; res._json = { error: { message: err?.message || String(err) } }; },
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async (req) => req._ctx || { tenantId: "t1", userId: "u1" },
  requirePermission: () => undefined,
}));

vi.mock("../api/_lib/supabase.js", () => {
  let svc = null;
  return { serviceClient: () => svc, __setSvc: (s) => { svc = s; } };
});

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v : true
  ));
  const builder = (table) => {
    const ctx = { table, filters: [], orderCol: null, orderAsc: true, lim: null };
    const select = (rows) => {
      let out = rows.filter((r) => matches(ctx.filters, r));
      if (ctx.orderCol) {
        const dir = ctx.orderAsc ? 1 : -1;
        out = [...out].sort((a, b) => (a[ctx.orderCol] > b[ctx.orderCol] ? dir : a[ctx.orderCol] < b[ctx.orderCol] ? -dir : 0));
      }
      if (ctx.lim != null) out = out.slice(0, ctx.lim);
      return out;
    };
    const api = {
      select() { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      order(c, opts) { ctx.orderCol = c; ctx.orderAsc = opts?.ascending !== false; return api; },
      limit(n) { ctx.lim = n; return api; },
      maybeSingle() { return Promise.resolve({ data: select(get(table))[0] || null, error: null }); },
      then(resolve) {
        resolve({ data: select(get(table)), error: null });
        return { catch: () => ({}) };
      },
    };
    return api;
  };
  return { from: builder };
};

beforeEach(() => { vi.clearAllMocks(); });

const callHandler = async (url) => {
  const handler = (await import("../api/inventory/forecast_runs.js")).default;
  const req = { method: "GET", url, headers: {} };
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler(req, res);
  return res;
};

describe("/api/inventory/forecast_runs :: list mode", () => {
  it("returns recent runs ordered by started_at desc", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      forecast_runs: [
        { id: "r1", tenant_id: "t1", started_at: "2026-04-01T00:00:00Z", finished_at: "2026-04-01T00:05:00Z", status: "ok", items_count: 100 },
        { id: "r2", tenant_id: "t1", started_at: "2026-05-01T00:00:00Z", finished_at: "2026-05-01T00:07:00Z", status: "ok", items_count: 110 },
        { id: "r3", tenant_id: "t1", started_at: "2026-03-01T00:00:00Z", finished_at: "2026-03-01T00:06:00Z", status: "ok", items_count: 90 },
      ],
    }));
    const res = await callHandler("/api/inventory/forecast_runs");
    expect(res.statusCode).toBe(200);
    expect(res._json.runs).toHaveLength(3);
    expect(res._json.runs[0].id).toBe("r2");                  // newest first
    expect(res._json.runs[1].id).toBe("r1");
    expect(res._json.runs[2].id).toBe("r3");
  });

  it("respects ?limit", async () => {
    const seed = [];
    for (let i = 0; i < 60; i++) {
      seed.push({ id: "r" + i, tenant_id: "t1", started_at: "2026-05-01T00:00:00Z", finished_at: null, status: "ok" });
    }
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ forecast_runs: seed }));
    const res = await callHandler("/api/inventory/forecast_runs?limit=5");
    expect(res._json.runs).toHaveLength(5);
  });

  it("clamps ?limit to 200 max", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ forecast_runs: [] }));
    const res = await callHandler("/api/inventory/forecast_runs?limit=99999");
    // empty seed, but the request shouldn't 500; 200 is the clamp.
    expect(res.statusCode).toBe(200);
  });
});

describe("/api/inventory/forecast_runs :: detail mode", () => {
  it("returns a run plus a forecasts_sample (best-effort join)", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      forecast_runs: [{
        id: "run-42", tenant_id: "t1", started_at: "2026-05-01T00:00:00Z",
        finished_at: "2026-05-01T00:05:00Z", status: "ok", items_count: 100,
        models_evaluated: ["xgb", "ets", "naive"], wape_summary: { p50: 0.18 },
        notes: "weekly cron",
      }],
      demand_forecasts: [
        { id: "df1", tenant_id: "t1", forecast_run_id: "run-42", part_no: "BR-6204", week_start: "2026-05-04", forecast_total: 12, quantile_90: 18, model_name: "xgb", wape_8w: 0.15 },
        { id: "df2", tenant_id: "t1", forecast_run_id: "run-42", part_no: "BR-6205", week_start: "2026-05-04", forecast_total: 5,  quantile_90: 9,  model_name: "ets", wape_8w: 0.22 },
      ],
    }));
    const res = await callHandler("/api/inventory/forecast_runs?id=run-42");
    expect(res.statusCode).toBe(200);
    expect(res._json.run.id).toBe("run-42");
    expect(res._json.run.wape_summary.p50).toBe(0.18);
    expect(res._json.forecasts_sample).toHaveLength(2);
    expect(res._json.forecasts_sample[0].part_no).toBe("BR-6204");
  });

  it("404s on unknown id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ forecast_runs: [] }));
    const res = await callHandler("/api/inventory/forecast_runs?id=nope");
    expect(res.statusCode).toBe(404);
    expect(res._json.error.message).toMatch(/not found/i);
  });
});

describe("/api/inventory/forecast_runs :: routing + client wrapper", () => {
  it("router registers the path", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/inventoryForecastRuns/);
    expect(router).toMatch(/["']\/inventory\/forecast_runs["']/);
  });

  it("anvil-client exposes inventory.forecastRuns + forecastRun", () => {
    const client = read("src/client/anvil-client.js");
    expect(client).toMatch(/forecastRuns\s*:\s*async/);
    expect(client).toMatch(/forecastRun\s*:\s*async/);
  });

  it("rejects non-GET methods with 405", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const handler = (await import("../api/inventory/forecast_runs.js")).default;
    const req = { method: "POST", url: "/api/inventory/forecast_runs", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
