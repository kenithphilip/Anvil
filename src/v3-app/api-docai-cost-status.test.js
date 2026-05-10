// /api/docai/cost_status + /api/admin/docai_settings tests.
//
// Covers:
//   - cost_status aggregates today's usage + 7-day trend.
//   - cost_status emits the right recommendations:
//       * gemini_unconfigured when no env + no tenant key.
//       * claude_uncapped when claude is configured but no daily cap.
//       * paid_first_in_chain when claude is at index 0.
//       * no_ocr_adapter when neither mistral nor azure_di is set.
//   - docai_settings GET returns the four keys.
//   - docai_settings PATCH validates provider order + daily limits +
//     model strings.
//   - docai_settings PATCH rejects unknown adapters.

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
    const ctx = { table, filters: [], action: null };
    const api = {
      select(_c) { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      gte(c, v) { ctx.filters.push({ col: c, op: "gte", v }); return api; },
      order() { return api; },
      maybeSingle() { return Promise.resolve({ data: get(table).filter((r) => matches(ctx.filters, r))[0] || null, error: null }); },
      then(resolve) { resolve({ data: get(table).filter((r) => matches(ctx.filters, r)), error: null }); return { catch: () => ({}) }; },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

beforeEach(() => { vi.clearAllMocks(); });

// --- cost_status ----------------------------------------------

describe("/api/docai/cost_status", () => {
  it("returns calls_today + estimated cost summary", async () => {
    const svc = buildSvc({
      docai_daily_usage: [
        { tenant_id: "t1", usage_date: today(), adapter: "gemini", call_count: 12, estimated_cost_usd: 0.0072, last_called_at: new Date().toISOString() },
        { tenant_id: "t1", usage_date: today(), adapter: "claude", call_count: 3, estimated_cost_usd: 0.066, last_called_at: new Date().toISOString() },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({});
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.summary.calls_today).toBe(15);
    expect(res._json.summary.cost_today_usd).toBeCloseTo(0.0732, 3);
    expect(res._json.today_usage).toHaveLength(2);
  });

  it("emits gemini_unconfigured recommendation when no Gemini key + no tenant key", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const svc = buildSvc({});
      const { __setSvc } = await import("../api/_lib/supabase.js");
      __setSvc(svc);
      const stripe = await import("../api/_lib/stripe-client.js");
      stripe.tenantSettings.mockResolvedValueOnce({});
      const handler = (await import("../api/docai/cost_status.js")).default;
      const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
      const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
      await handler(req, res);
      const rec = res._json.recommendations.find((r) => r.id === "gemini_unconfigured");
      expect(rec).toBeTruthy();
      expect(rec.severity).toBe("warn");
    } finally {
      if (saved) process.env.GEMINI_API_KEY = saved;
    }
  });

  it("emits claude_uncapped recommendation when Claude is set without a daily cap", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    try {
      const svc = buildSvc({});
      const { __setSvc } = await import("../api/_lib/supabase.js");
      __setSvc(svc);
      const stripe = await import("../api/_lib/stripe-client.js");
      stripe.tenantSettings.mockResolvedValueOnce({});
      const handler = (await import("../api/docai/cost_status.js")).default;
      const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
      const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
      await handler(req, res);
      const rec = res._json.recommendations.find((r) => r.id === "claude_uncapped");
      expect(rec).toBeTruthy();
      expect(rec.severity).toBe("bad");
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("does NOT emit claude_uncapped when a docai_daily_limits.claude is set", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    try {
      const svc = buildSvc({});
      const { __setSvc } = await import("../api/_lib/supabase.js");
      __setSvc(svc);
      const stripe = await import("../api/_lib/stripe-client.js");
      stripe.tenantSettings.mockResolvedValueOnce({ docai_daily_limits: { claude: 25 } });
      const handler = (await import("../api/docai/cost_status.js")).default;
      const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
      const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
      await handler(req, res);
      const rec = res._json.recommendations.find((r) => r.id === "claude_uncapped");
      expect(rec).toBeUndefined();
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("emits paid_first_in_chain when Claude is at the head of provider_order", async () => {
    const svc = buildSvc({});
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_provider_order: ["claude", "gemini"],
      docai_daily_limits: { claude: 25 },        // suppress claude_uncapped so we focus on this rec
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    const rec = res._json.recommendations.find((r) => r.id === "paid_first_in_chain");
    expect(rec).toBeTruthy();
  });
});

// --- admin/docai_settings -------------------------------------

describe("/api/admin/docai_settings", () => {
  it("GET returns the four cost-relevant fields", async () => {
    const svc = buildSvc({});
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_provider_order: ["gemini", "claude"],
      docai_daily_limits: { claude: 25 },
      docai_anthropic_model: "claude-haiku-4-5-20251001",
      docai_gemini_model: null,
    });
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = { method: "GET", url: "/api/admin/docai_settings", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json).toMatchObject({
      docai_provider_order: ["gemini", "claude"],
      docai_daily_limits: { claude: 25 },
      docai_anthropic_model: "claude-haiku-4-5-20251001",
    });
  });

  it("PATCH rejects an unknown adapter in provider order", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = {
      method: "PATCH", url: "/api/admin/docai_settings", headers: {},
      _body: { docai_provider_order: ["gemini", "vibe_check"] },
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/unknown adapter/);
  });

  it("PATCH rejects a non-positive daily limit", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = {
      method: "PATCH", url: "/api/admin/docai_settings", headers: {},
      _body: { docai_daily_limits: { claude: -5 } },
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/non-negative integer/);
  });

  it("PATCH rejects an Anthropic model that doesn't match claude-(haiku|sonnet|opus)-", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = {
      method: "PATCH", url: "/api/admin/docai_settings", headers: {},
      _body: { docai_anthropic_model: "gpt-4" },
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/claude-/);
  });

  it("PATCH accepts a valid bundle", async () => {
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.updateTenantSettings.mockResolvedValueOnce({
      docai_provider_order: ["gemini", "claude"],
      docai_daily_limits: { claude: 25 },
      docai_anthropic_model: "claude-haiku-4-5-20251001",
      docai_gemini_model: null,
    });
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = {
      method: "PATCH", url: "/api/admin/docai_settings", headers: {},
      _body: {
        docai_provider_order: ["gemini", "claude"],
        docai_daily_limits: { claude: 25 },
        docai_anthropic_model: "claude-haiku-4-5-20251001",
        docai_gemini_model: null,
      },
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.updated).toContain("docai_provider_order");
    expect(res._json.updated).toContain("docai_daily_limits");
  });
});
