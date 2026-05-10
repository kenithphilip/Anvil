// Bet 1: foundation-model cost compression.
//
// Covers:
//   - Gemini MODEL_BY_TIER default bumped to gemini-3-flash-preview /
//     gemini-3.1-pro-preview.
//   - Anthropic MODEL_BY_TIER default bumped to claude-sonnet-4-6 /
//     claude-opus-4-7.
//   - Mistral OCR default bumped to mistral-ocr-3 + batch flag.
//   - Dispatcher confidence threshold reads
//     settings.docai_fallback_confidence (default 0.85, was 0.7).
//   - cost_status.js: R7 fires on legacy gemini-2.5 pin; R8 fires
//     on docai_fallback_confidence < 0.85.
//   - admin/docai_settings.js: validates the three new fields
//     (fallback_confidence range, mistral_ocr_batch boolean,
//     gemini_media_resolution enum).
//   - cost_guard.js: mistral_ocr key present.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- module-level imports for the pure libs --------------------

describe("Bet 1 :: model defaults", () => {
  it("Gemini MODEL_BY_TIER defaults to Gemini 3 Flash + 3.1 Pro", async () => {
    const saved = {
      preflight: process.env.GEMINI_MODEL_PREFLIGHT,
      generation: process.env.GEMINI_MODEL_DEFAULT,
      reasoning: process.env.GEMINI_MODEL_REASONING,
    };
    delete process.env.GEMINI_MODEL_PREFLIGHT;
    delete process.env.GEMINI_MODEL_DEFAULT;
    delete process.env.GEMINI_MODEL_REASONING;
    try {
      vi.resetModules();
      const { MODEL_BY_TIER } = await import("../api/_lib/gemini.js");
      expect(MODEL_BY_TIER.preflight).toBe("gemini-3-flash-preview");
      expect(MODEL_BY_TIER.generation).toBe("gemini-3-flash-preview");
      expect(MODEL_BY_TIER.reasoning).toBe("gemini-3.1-pro-preview");
    } finally {
      if (saved.preflight) process.env.GEMINI_MODEL_PREFLIGHT = saved.preflight;
      if (saved.generation) process.env.GEMINI_MODEL_DEFAULT = saved.generation;
      if (saved.reasoning) process.env.GEMINI_MODEL_REASONING = saved.reasoning;
    }
  });

  it("Anthropic MODEL_BY_TIER defaults to Sonnet 4.6 / Opus 4.7", async () => {
    const saved = {
      preflight: process.env.ANTHROPIC_MODEL_PREFLIGHT,
      generation: process.env.ANTHROPIC_MODEL_DEFAULT,
      reasoning: process.env.ANTHROPIC_MODEL_REASONING,
    };
    delete process.env.ANTHROPIC_MODEL_PREFLIGHT;
    delete process.env.ANTHROPIC_MODEL_DEFAULT;
    delete process.env.ANTHROPIC_MODEL_REASONING;
    try {
      vi.resetModules();
      const { MODEL_BY_TIER } = await import("../api/_lib/anthropic.js");
      expect(MODEL_BY_TIER.preflight).toBe("claude-sonnet-4-6");
      expect(MODEL_BY_TIER.generation).toBe("claude-sonnet-4-6");
      expect(MODEL_BY_TIER.reasoning).toBe("claude-opus-4-7");
    } finally {
      if (saved.preflight) process.env.ANTHROPIC_MODEL_PREFLIGHT = saved.preflight;
      if (saved.generation) process.env.ANTHROPIC_MODEL_DEFAULT = saved.generation;
      if (saved.reasoning) process.env.ANTHROPIC_MODEL_REASONING = saved.reasoning;
    }
  });

  it("Mistral OCR default model is mistral-ocr-3 with batch flag", async () => {
    const saved = process.env.MISTRAL_OCR_MODEL;
    delete process.env.MISTRAL_OCR_MODEL;
    try {
      const src = (await import("node:fs"))
        .readFileSync(
          (await import("node:path")).resolve(process.cwd(), "src/api/_lib/mistral.js"),
          "utf8",
        );
      expect(src).toMatch(/DEFAULT_OCR_MODEL\s*=\s*"mistral-ocr-3"/);
      expect(src).toMatch(/BATCH_OCR_URL\s*=\s*"https:\/\/api\.mistral\.ai\/v1\/ocr\/batch"/);
      expect(src).toMatch(/useBatch\s*=\s*opts\?\.batch\s*===\s*true/);
    } finally {
      if (saved) process.env.MISTRAL_OCR_MODEL = saved;
    }
  });
});

// ---- cost_guard ------------------------------------------------

describe("Bet 1 :: cost_guard", () => {
  it("DEFAULT_COST_USD has gemini at the new ~$0.0035 default and a mistral_ocr key", async () => {
    const src = (await import("node:fs"))
      .readFileSync(
        (await import("node:path")).resolve(process.cwd(), "src/api/_lib/cost_guard.js"),
        "utf8",
      );
    // Gemini default is bumped to Gemini 3 Flash pricing.
    expect(src).toMatch(/COST_USD_GEMINI_3_FLASH/);
    expect(src).toMatch(/0\.0035/);
    // Mistral OCR is now first-class.
    expect(src).toMatch(/mistral_ocr:/);
    expect(src).toMatch(/COST_USD_MISTRAL_OCR_3/);
  });
});

// ---- cost_status R7 + R8 ---------------------------------------

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = err?.status || 500; res._json = { error: { message: err?.message || String(err) } }; },
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

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v
    : f.op === "gte" ? String(r[f.col]) >= String(f.v)
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

beforeEach(() => { vi.clearAllMocks(); });

describe("Bet 1 :: cost_status R7 (Gemini 2.5 legacy pin)", () => {
  it("fires when geminiModel pin matches /^gemini-2\\.5/", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_gemini_model: "gemini-2.5-flash",
      docai_anthropic_model: null,
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    const r = res._json.recommendations.find((x) => x.id === "gemini_25_legacy_pin");
    expect(r).toBeTruthy();
    expect(r.severity).toBe("info");
  });

  it("does NOT fire when geminiModel pin is gemini-3-flash-preview", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_gemini_model: "gemini-3-flash-preview",
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res._json.recommendations.find((x) => x.id === "gemini_25_legacy_pin")).toBeUndefined();
  });
});

describe("Bet 1 :: cost_status R8 (low fallback confidence)", () => {
  it("fires when docai_fallback_confidence is below 0.85", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_fallback_confidence: 0.70,
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    const r = res._json.recommendations.find((x) => x.id === "fallback_confidence_low");
    expect(r).toBeTruthy();
    expect(r.severity).toBe("warn");
  });

  it("does NOT fire at the platform default of 0.85", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_fallback_confidence: 0.85,
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res._json.recommendations.find((x) => x.id === "fallback_confidence_low")).toBeUndefined();
  });
});

describe("Bet 1 :: cost_status response surfaces new fields", () => {
  it("returns gemini_model + fallback_confidence + mistral_ocr_batch + gemini_media_resolution", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({ docai_daily_usage: [] }));
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({
      docai_fallback_confidence: 0.92,
      docai_mistral_ocr_batch: false,
      docai_gemini_media_resolution: "medium",
    });
    const handler = (await import("../api/docai/cost_status.js")).default;
    const req = { method: "GET", url: "/api/docai/cost_status", headers: {} };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res._json.fallback_confidence).toBe(0.92);
    expect(res._json.mistral_ocr_batch).toBe(false);
    expect(res._json.gemini_media_resolution).toBe("medium");
    expect(res._json.gemini_model).toMatch(/gemini-3-flash/);
  });
});

// ---- admin/docai_settings validators ----------------------------

describe("Bet 1 :: admin/docai_settings PATCH validators", () => {
  it("PATCH accepts docai_fallback_confidence in [0.50, 0.99]", async () => {
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.updateTenantSettings.mockResolvedValueOnce({ docai_fallback_confidence: 0.90 });
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = { method: "PATCH", url: "/api/admin/docai_settings", headers: {}, _body: { docai_fallback_confidence: 0.90 } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("PATCH rejects docai_fallback_confidence outside [0.50, 0.99]", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = { method: "PATCH", url: "/api/admin/docai_settings", headers: {}, _body: { docai_fallback_confidence: 0.49 } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/0\.50.*0\.99/);
  });

  it("PATCH rejects unknown gemini_media_resolution", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = { method: "PATCH", url: "/api/admin/docai_settings", headers: {}, _body: { docai_gemini_media_resolution: "ultra_low" } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/low, medium, high, ultra_high/);
  });

  it("PATCH rejects non-boolean mistral_ocr_batch", async () => {
    const handler = (await import("../api/admin/docai_settings.js")).default;
    const req = { method: "PATCH", url: "/api/admin/docai_settings", headers: {}, _body: { docai_mistral_ocr_batch: "yes" } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/boolean/);
  });
});

// ---- dispatcher confidence threshold ----------------------------

describe("Bet 1 :: dispatcher reads docai_fallback_confidence", () => {
  it("source uses settings?.docai_fallback_confidence with 0.85 default", async () => {
    const src = (await import("node:fs"))
      .readFileSync(
        (await import("node:path")).resolve(process.cwd(), "src/api/_lib/docai/index.js"),
        "utf8",
      );
    expect(src).toMatch(/settings\?\.docai_fallback_confidence/);
    expect(src).toMatch(/0\.85/);
    // The legacy hardcoded `>= 0.7` cutoff must be replaced.
    expect(src).not.toMatch(/conf == null \|\| conf >= 0\.7\s*\)/);
  });
});
