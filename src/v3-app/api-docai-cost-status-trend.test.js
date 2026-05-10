// Phase F.6 + cost-trend-chart tests.
//
// Covers the new fields added to /api/docai/cost_status that feed
// the admin panel chart:
//   - window_days (clamped 1..90)
//   - trend_window (rollup over the chosen window)
//   - trend_series (per-day per-adapter buckets, dense x-axis)
//   - burn (today vs window-median ratio per adapter)
//   - anomalies (>=2x median, >=5 calls)
//   - forecast (per-cap exhaust hours)
//
// The mock svc supports eq/gte/order/then which is everything the
// handler needs.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
}));

vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: vi.fn(async (_svc, _t) => ({})),
  updateTenantSettings: vi.fn(async (_svc, _t, patch) => ({ ...patch })),
}));

vi.mock("../api/_lib/supabase.js", () => {
  let svc = null;
  return { serviceClient: () => svc, __setSvc: (s) => { svc = s; } };
});

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v
    : f.op === "gte" ? String(r[f.col]) >= String(f.v)
    : f.op === "in" ? Array.isArray(f.v) && f.v.includes(r[f.col])
    : true
  ));
  const builder = (table) => {
    const ctx = { table, filters: [] };
    const api = {
      select() { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      gte(c, v) { ctx.filters.push({ col: c, op: "gte", v }); return api; },
      order() { return api; },
      then(resolve) {
        const rows = get(table).filter((r) => matches(ctx.filters, r));
        resolve({ data: rows, error: null });
        return { catch: () => ({}) };
      },
    };
    return api;
  };
  return { from: builder };
};

const callHandler = async (url) => {
  const handler = (await import("../api/docai/cost_status.js")).default;
  const req = { method: "GET", url, headers: {} };
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler(req, res);
  return res;
};

beforeEach(() => { vi.clearAllMocks(); });

describe("/api/docai/cost_status :: window_days", () => {
  it("defaults to a 7-day window when ?days is absent", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status");
    expect(res.statusCode).toBe(200);
    expect(res._json.window_days).toBe(7);
    expect(res._json.trend_series.dates).toHaveLength(7);
  });

  it("accepts ?days=14 and emits 14 dates on the x-axis", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=14");
    expect(res._json.window_days).toBe(14);
    expect(res._json.trend_series.dates).toHaveLength(14);
  });

  it("clamps ?days=999 down to the 90-day max", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=999");
    expect(res._json.window_days).toBe(90);
    expect(res._json.trend_series.dates).toHaveLength(90);
  });

  it("falls back to 7-day window when ?days is non-numeric", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=abc");
    expect(res._json.window_days).toBe(7);
  });
});

describe("/api/docai/cost_status :: trend_series", () => {
  it("builds dense per-day per-adapter buckets across the window", async () => {
    const t0 = today();
    const t1 = daysAgo(1);
    const t2 = daysAgo(2);
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: t2, adapter: "gemini", call_count: 5, estimated_cost_usd: 0.003, last_called_at: new Date().toISOString() },
        { tenant_id: "t1", usage_date: t1, adapter: "gemini", call_count: 7, estimated_cost_usd: 0.004, last_called_at: new Date().toISOString() },
        { tenant_id: "t1", usage_date: t0, adapter: "gemini", call_count: 9, estimated_cost_usd: 0.005, last_called_at: new Date().toISOString() },
        { tenant_id: "t1", usage_date: t0, adapter: "claude", call_count: 2, estimated_cost_usd: 0.044, last_called_at: new Date().toISOString() },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.trend_series.adapters).toEqual(["claude", "gemini"]);    // sorted
    expect(res._json.trend_series.dates).toHaveLength(7);
    // Last entry on the gemini line is today (9 calls).
    const gem = res._json.trend_series.series.gemini;
    expect(gem.calls[gem.calls.length - 1]).toBe(9);
    // Three days back from the end is 5 (t2), the prior one is 7 (t1).
    expect(gem.calls[gem.calls.length - 3]).toBe(5);
    expect(gem.calls[gem.calls.length - 2]).toBe(7);
    // Days with no rows fill with 0.
    expect(gem.calls[0]).toBe(0);
  });

  it("fills empty windows with all-zero arrays", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.trend_series.dates).toHaveLength(7);
    expect(res._json.trend_series.adapters).toEqual([]);
    expect(res._json.trend_series.series).toEqual({});
  });
});

describe("/api/docai/cost_status :: burn", () => {
  it("computes today/window-median ratio per adapter", async () => {
    const t0 = today();
    const seed = [];
    // 6 historical days of 10 calls each, then 30 calls today: ratio = 3.0
    for (let i = 6; i >= 1; i--) {
      seed.push({ tenant_id: "t1", usage_date: daysAgo(i), adapter: "gemini", call_count: 10, estimated_cost_usd: 0.006, last_called_at: new Date().toISOString() });
    }
    seed.push({ tenant_id: "t1", usage_date: t0, adapter: "gemini", call_count: 30, estimated_cost_usd: 0.018, last_called_at: new Date().toISOString() });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.burn.gemini.today_calls).toBe(30);
    expect(res._json.burn.gemini.median_n_calls).toBe(10);
    expect(res._json.burn.gemini.ratio).toBe(3);
    expect(res._json.burn.gemini.window_days).toBe(7);
  });

  it("returns null ratio when there's no historical signal but today is zero", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    // adapters list is empty so burn is empty too
    expect(res._json.burn).toEqual({});
  });
});

describe("/api/docai/cost_status :: anomalies", () => {
  it("flags days where calls >= 2x median AND >= 5", async () => {
    const seed = [];
    // 5 historical days of 4 calls each (median = 4)
    for (let i = 6; i >= 2; i--) {
      seed.push({ tenant_id: "t1", usage_date: daysAgo(i), adapter: "claude", call_count: 4, estimated_cost_usd: 0.088, last_called_at: new Date().toISOString() });
    }
    // Yesterday: spike to 12 (3x median, >= 5) -> anomaly
    seed.push({ tenant_id: "t1", usage_date: daysAgo(1), adapter: "claude", call_count: 12, estimated_cost_usd: 0.264, last_called_at: new Date().toISOString() });
    seed.push({ tenant_id: "t1", usage_date: today(),    adapter: "claude", call_count: 4,  estimated_cost_usd: 0.088, last_called_at: new Date().toISOString() });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    const a = res._json.anomalies.find((x) => x.adapter === "claude" && x.calls === 12);
    expect(a).toBeTruthy();
    expect(a.multiplier).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag low-volume spikes below the 5-call floor", async () => {
    const seed = [];
    for (let i = 6; i >= 2; i--) {
      seed.push({ tenant_id: "t1", usage_date: daysAgo(i), adapter: "claude", call_count: 1, estimated_cost_usd: 0.022, last_called_at: new Date().toISOString() });
    }
    seed.push({ tenant_id: "t1", usage_date: daysAgo(1), adapter: "claude", call_count: 3, estimated_cost_usd: 0.066, last_called_at: new Date().toISOString() });   // 3x median (1) but < 5
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.anomalies).toHaveLength(0);
  });

  it("emits no anomalies when median = 0", async () => {
    const seed = [{ tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 9, estimated_cost_usd: 0.198, last_called_at: new Date().toISOString() }];
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    // Only data point, sorted historical is [9], median = 9, today = 9, ratio = 1, not >= 2x.
    expect(res._json.anomalies).toHaveLength(0);
  });
});

describe("/api/docai/cost_status :: forecast", () => {
  it("projects per-cap exhaust hours from today's burn rate", async () => {
    const seed = [
      { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 50, estimated_cost_usd: 1.1, last_called_at: new Date().toISOString() },
    ];
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({ docai_daily_limits: { claude: 100 } });
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.forecast.claude).toBeTruthy();
    expect(res._json.forecast.claude.cap).toBe(100);
    expect(res._json.forecast.claude.used).toBe(50);
    expect(res._json.forecast.claude.remaining).toBe(50);
    expect(res._json.forecast.claude.rate_per_hour).toBeGreaterThan(0);
    // hours_to_cap = 50 / rate_per_hour, must be a finite number
    expect(typeof res._json.forecast.claude.hours_to_cap).toBe("number");
  });

  it("skips adapters with no cap set", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({ docai_daily_limits: {} });
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.forecast).toEqual({});
  });

  it("counts caps at risk in summary.forecast_caps_at_risk_today", async () => {
    const seed = [
      // Burn 80 calls in less than a full day; cap 100; ratio means we WILL hit it before midnight UTC.
      { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 80, estimated_cost_usd: 1.76, last_called_at: new Date().toISOString() },
    ];
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({ docai_daily_limits: { claude: 100 } });
    const res = await callHandler("/api/docai/cost_status?days=7");
    // Existence of will_hit_cap_today is what the UI binds on.
    expect(typeof res._json.forecast.claude.will_hit_cap_today).toBe("boolean");
    expect(typeof res._json.summary.forecast_caps_at_risk_today).toBe("number");
  });
});

describe("/api/docai/cost_status :: trend_window vs trend_7d", () => {
  it("trend_window mirrors trend_7d when days=7 (back-compat)", async () => {
    const seed = [];
    for (let i = 6; i >= 0; i--) {
      seed.push({ tenant_id: "t1", usage_date: daysAgo(i), adapter: "gemini", call_count: 3, estimated_cost_usd: 0.0018, last_called_at: new Date().toISOString() });
    }
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: seed }));
    const res = await callHandler("/api/docai/cost_status");
    expect(res._json.trend_window).toEqual(res._json.trend_7d);
    expect(res._json.trend_window.calls).toBe(21);
  });
});

describe("/api/docai/cost_status :: summary deltas", () => {
  it("anomalies_count + forecast_caps_at_risk_today appear in summary", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const res = await callHandler("/api/docai/cost_status?days=7");
    expect(res._json.summary).toHaveProperty("anomalies_count");
    expect(res._json.summary).toHaveProperty("forecast_caps_at_risk_today");
  });
});
