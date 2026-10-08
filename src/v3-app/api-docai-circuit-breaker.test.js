// The provider circuit breaker, through the real dispatcher, Gemini adapter and
// Claude adapter, with only the network, Supabase and the clock stubbed.
//
// On 2026-10-07 run f0e2b29a spent 20,752ms learning that Gemini was
// overloaded (503 "high demand" on its primary model, then on its fallback
// model). Claude was then skipped for lack of time and LlamaParse timed out.
// Five more runs that day paid the same 20s for the same answer. The breaker
// reads the tenant's recent extraction_runs.adapter_attempts, and while a
// provider's latest overload is under N minutes old with no success since, the
// dispatcher skips it and gives its time to the next adapters.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ fetch: null, now: 0, svc: null, llamaparseConfigured: true }));

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.svc }));
vi.mock("../api/_lib/safe-fetch.js", () => ({ safeFetch: (url, init) => H.fetch(url, init) }));
vi.mock("../api/_lib/docai/adapter-learning.js", () => ({ rankAdaptersForCustomer: async ({ defaultOrder }) => defaultOrder }));
vi.mock("../api/_lib/docai/pdf-metadata.js", () => ({ readPdfBias: async () => null, composeOrderWithBias: (o) => o }));
// The real Claude adapter, watched so a test can read the deadline (its slot)
// the dispatcher handed it.
vi.mock("../api/_lib/docai/claude.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, extract: vi.fn((args) => real.extract(args)) };
});
for (const m of ["docling", "marker", "unstructured", "azure_di", "reducto"]) {
  vi.doMock("../api/_lib/docai/" + m + ".js", () => ({ isConfigured: () => false, extract: vi.fn() }));
}
// The configured last resort. Its own parsing is not under test here.
vi.mock("../api/_lib/docai/llamaparse.js", () => ({
  isConfigured: () => H.llamaparseConfigured,
  extract: vi.fn(async () => ({
    ok: true,
    reason: "ok",
    normalized: { classification: "po", customer: null, lines: [{ partNumber: "ROW-1", quantity: 1 }] },
    confidences: { overall: 0.6 },
  })),
}));

const { dispatchExtract, withEngineOverride, LLM_MIN_ATTEMPT_MS } = await import("../api/_lib/docai/index.js");
const breaker = await import("../api/_lib/docai/circuit-breaker.js");
const { llmUnavailableFallback, llmUnavailableAnomaly } = await import("../api/_lib/docai/llm-fallback.js");
const claudeAdapter = await import("../api/_lib/docai/claude.js");
const llamaparse = await import("../api/_lib/docai/llamaparse.js");

const ORDER = ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
const PO_TEXT = "PURCHASE ORDER\nPO No: 4500012345\nBuyer: Fixture Motors Pvt Ltd\n1 ZX-1001 GUIDE BLOCK 4 NOS 250.00\n";
const MIN = 60_000;
// What the dispatcher holds back for LlamaParse, the parser queued last.
const PARSER_FLOOR_MS = 6000;
const iso = (ms) => new Date(ms).toISOString();

// ---- network -------------------------------------------------------------

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
const overloadBody = {
  error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary.", status: "UNAVAILABLE" },
};
const poAnswer = {
  classification: "po",
  confidence: 0.93,
  customer: { name: "Fixture Motors Pvt Ltd", po_number: "4500012345", currency: "INR" },
  lines: [{ partNumber: "ZX-1001", description: "GUIDE BLOCK", quantity: 4, unitPrice: 250, uom: "NOS" }],
};
const claudeAnswer = {
  content: [{ type: "tool_use", name: "extract_purchase_order", input: poAnswer }],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 10 },
};
const geminiAnswer = { candidates: [{ content: { parts: [{ text: JSON.stringify(poAnswer) }] }, finishReason: "STOP" }] };

const isGemini = (url) => String(url).includes("generativelanguage");
const isClaude = (url) => String(url).includes("api.anthropic.com");

// Counts calls per provider and records when Claude was called and with what
// timeout. `gemini` is "overloaded" or "ok".
const network = ({ gemini = "overloaded", geminiMs = 9000 } = {}) => {
  const seen = { gemini: 0, claude: [] };
  H.fetch = async (url, init) => {
    if (isGemini(url)) {
      seen.gemini += 1;
      const ms = Math.min(geminiMs, init.timeoutMs);
      H.now += ms;
      if (ms < geminiMs) throw new Error("Upstream generativelanguage.googleapis.com did not respond within " + init.timeoutMs + "ms");
      return gemini === "ok" ? response(200, geminiAnswer) : response(503, overloadBody);
    }
    if (isClaude(url)) {
      seen.claude.push({ at: H.now, timeoutMs: init.timeoutMs });
      H.now += 3000;
      return response(200, claudeAnswer);
    }
    throw new Error("unexpected fetch " + url);
  };
  return seen;
};

// ---- Supabase ------------------------------------------------------------

// A fake client over a list of extraction_runs rows. It honours the eq and gte
// filters the way PostgREST does, and records every extraction_runs query.
const makeSvc = (rows) => {
  const queries = [];
  return {
    queries,
    from(table) {
      const filters = [];
      if (table === "extraction_runs") queries.push(filters);
      const result = () => {
        if (table !== "extraction_runs") return { data: [], error: null };
        let out = rows;
        for (const [op, col, val] of filters) {
          if (op === "eq") out = out.filter((r) => r[col] === val);
          if (op === "gte") out = out.filter((r) => String(r[col]) >= String(val));
        }
        return { data: out, error: null };
      };
      const api = {
        select() { return api; },
        eq(col, val) { filters.push(["eq", col, val]); return api; },
        gte(col, val) { filters.push(["gte", col, val]); return api; },
        order() { return api; }, limit() { return api; },
        update() { return api; }, insert() { return api; }, upsert() { return api; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return api;
    },
  };
};

// The attempts run f0e2b29a recorded: Gemini overloaded on both models, Claude
// skipped for lack of time, LlamaParse timed out. As #562 wrote them, so each
// model call carries its HTTP status but no failure_class of its own.
const f0e2b29aAttempts = () => [
  {
    adapter: "gemini", status: "failed", ms: 20752, reason: "upstream_error",
    error: "503 model overloaded (high demand) on gemini-3.6-flash: This model is currently experiencing high demand.",
    failure_class: "overload", transient: true,
    models: [
      { model: "gemini-3.6-flash", status: 503, ms: 10376 },
      { model: "gemini-3-flash-preview", status: 503, ms: 10376 },
    ],
  },
  { adapter: "docling", status: "skipped_not_configured" },
  { adapter: "claude", status: "skipped_insufficient_budget", reason: "llm_attempt_would_be_too_short", available_ms: 5100, needed_ms: 7500 },
  { adapter: "llamaparse", status: "failed", ms: 18702, reason: "timeout", error: "llamaparse timed out" },
];
const runRow = ({ tenant = "t1", finishedAt, attempts, status = "failed", statusReason = null }) => ({
  tenant_id: tenant,
  started_at: iso(finishedAt - 45_000),
  finished_at: iso(finishedAt),
  status,
  status_reason: statusReason,
  adapter_attempts: attempts,
});
const overloadedRun = (finishedAt, tenant = "t1") => runRow({ tenant, finishedAt, attempts: f0e2b29aAttempts() });
const geminiOkRun = (finishedAt) => runRow({
  finishedAt, status: "ok", attempts: [{ adapter: "gemini", status: "ok", ms: 4100, confidence: 0.93 }],
});

// ---- the run -------------------------------------------------------------

const run = ({ budgetMs = 30_000, tenant = "t1", settings = {} } = {}) => dispatchExtract({
  source: { bytes: Buffer.from("%PDF-1.4 fixture"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" },
  settings: { tenant_id: tenant, docai_provider_order: ORDER, docai_fallback_confidence: 0.85, ...settings },
  hints: {
    deadlineAt: H.now + budgetMs,
    bodyText: PO_TEXT,
    textLayer: { status: "has_text", char_count: PO_TEXT.length, page_count: 6 },
  },
});
const attempt = (out, adapter) => out.attempts.find((a) => a.adapter === adapter);
// The slot the dispatcher gave Claude: its deadline less the time it started.
const claudeSlotMs = (startedAt) => claudeAdapter.extract.mock.calls.at(-1)[0].hints.deadlineAt - startedAt;

const saved = {};
beforeEach(() => {
  for (const k of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_MODEL_FALLBACK", "DOCAI_BREAKER_MINUTES"]) saved[k] = process.env[k];
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  delete process.env.GEMINI_MODEL_FALLBACK;
  delete process.env.DOCAI_BREAKER_MINUTES;
  H.now = 1_800_000_000_000;
  H.llamaparseConfigured = true;
  vi.spyOn(Date, "now").mockImplementation(() => H.now);
  vi.mocked(llamaparse.extract).mockClear();
  vi.mocked(claudeAdapter.extract).mockClear();
  breaker.__resetCircuitBreakers();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
});

describe("recent overloads open the breaker", () => {
  it("skips Gemini at once and gives Claude its full slot", async () => {
    const start = H.now;
    H.svc = makeSvc([overloadedRun(start - 6 * MIN), overloadedRun(start - 3 * MIN)]);
    const seen = network();
    const out = await run({ budgetMs: 20_000 });

    expect(seen.gemini).toBe(0);
    const gemini = attempt(out, "gemini");
    expect(gemini.status).toBe("skipped_circuit_open");
    expect(gemini.reason).toBe("provider_overloaded_recently");
    // Opened by the first overload with no success after it; half-opens N
    // minutes after the latest one.
    expect(gemini.opened_at).toBe(iso(start - 6 * MIN));
    expect(gemini.last_overload_at).toBe(iso(start - 3 * MIN));
    expect(gemini.half_open_at).toBe(iso(start + 7 * MIN));
    expect(gemini.window_minutes).toBe(10);

    // Claude starts at once with everything but LlamaParse's floor.
    expect(seen.claude).toHaveLength(1);
    expect(seen.claude[0].at).toBe(start);
    expect(claudeSlotMs(start)).toBe(20_000 - PARSER_FLOOR_MS);
    expect(seen.claude[0].timeoutMs).toBe(20_000 - PARSER_FLOOR_MS);
    expect(out.adapter_used).toBe("claude");
    expect(llamaparse.extract).not.toHaveBeenCalled();
  });

  it("replays f0e2b29a (an overload 2 minutes earlier): Claude gets its full slot", async () => {
    // Without the breaker: the same run pays for Gemini's two 503s first.
    process.env.DOCAI_BREAKER_MINUTES = "0";
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    let start = H.now;
    let seen = network({ geminiMs: 9000 });
    await run({ budgetMs: 39_400 });
    expect(seen.gemini).toBe(2);
    const slotWithout = claudeSlotMs(start) - (seen.claude[0].at - start);

    // With it (the default, 10 minutes).
    delete process.env.DOCAI_BREAKER_MINUTES;
    breaker.__resetCircuitBreakers();
    start = H.now;
    H.svc = makeSvc([overloadedRun(start - 2 * MIN)]);
    seen = network({ geminiMs: 9000 });
    const out = await run({ budgetMs: 39_400 });

    expect(seen.gemini).toBe(0);
    expect(attempt(out, "gemini").status).toBe("skipped_circuit_open");
    expect(seen.claude[0].at).toBe(start);
    expect(claudeSlotMs(start)).toBe(39_400 - PARSER_FLOOR_MS);
    expect(claudeSlotMs(start)).toBeGreaterThan(slotWithout + 15_000);
    // Claude's whole configured ceiling, not a slice of what Gemini left.
    expect(seen.claude[0].timeoutMs).toBe(15_000);
    expect(out.adapter_used).toBe("claude");
  });

  it("holds back no time for an open provider queued later in the order", async () => {
    const start = H.now;
    H.svc = makeSvc([overloadedRun(start - 2 * MIN)]);
    network();
    const out = await run({ budgetMs: 20_000, settings: { docai_provider_order: ["claude", "gemini"] } });
    // Only LlamaParse's floor is held back. A queued Gemini would have taken
    // half the run.
    expect(claudeSlotMs(start)).toBe(20_000 - PARSER_FLOOR_MS);
    expect(out.adapter_used).toBe("claude");
  });

  it("still tries an open provider when nothing else could read the document", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    H.llamaparseConfigured = false;
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    const seen = network({ gemini: "ok" });
    const out = await run({ settings: { docai_provider_order: ["gemini"] } });
    expect(seen.gemini).toBe(1);
    expect(attempt(out, "gemini").breaker).toBe("open_last_resort");
    expect(out.adapter_used).toBe("gemini");
  });

  it("names the skip in the busy-models marker when a parser read the PO", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    network();
    // Claude is busy too.
    H.fetch = async (url, init) => {
      if (isClaude(url)) { H.now += init.timeoutMs; throw new Error("Upstream api.anthropic.com did not respond within " + init.timeoutMs + "ms"); }
      throw new Error("unexpected fetch " + url);
    };
    const out = await run();
    expect(out.adapter_used).toBe("llamaparse");
    const marker = llmUnavailableFallback({ ok: out.ok, adapterUsed: out.adapter_used, attempts: out.attempts });
    expect(marker.llm_attempts.map((a) => [a.adapter, a.status])).toEqual([
      ["gemini", "skipped_circuit_open"], ["claude", "failed"],
    ]);
    expect(llmUnavailableAnomaly(marker).detail).toContain("gemini skipped, overloaded in the last 10 minutes");
  });
});

describe("what keeps the breaker closed", () => {
  it("a later success", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 5 * MIN), geminiOkRun(H.now - 3 * MIN)]);
    const seen = network({ gemini: "ok" });
    const out = await run();
    expect(seen.gemini).toBe(1);
    expect(attempt(out, "gemini").status).toBe("ok");
    expect(attempt(out, "gemini").breaker).toBeUndefined();
    expect(out.adapter_used).toBe("gemini");
  });

  it("another tenant's overload", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN, "t2")]);
    const seen = network({ gemini: "ok" });
    const out = await run({ tenant: "t1" });
    expect(seen.gemini).toBe(1);
    expect(out.adapter_used).toBe("gemini");
    // The same rows do open it for the tenant they belong to.
    const other = await run({ tenant: "t2" });
    expect(attempt(other, "gemini").status).toBe("skipped_circuit_open");
  });

  it("an overload that did not hit every model", async () => {
    // #562's shape when the primary model was overloaded and the fallback
    // model then timed out: the provider was not shown to be out of capacity.
    const attempts = f0e2b29aAttempts();
    attempts[0] = {
      ...attempts[0], failure_class: "timeout",
      models: [attempts[0].models[0], { model: "gemini-3-flash-preview", status: 0, ms: 9000, error: "did not respond" }],
    };
    H.svc = makeSvc([runRow({ finishedAt: H.now - 2 * MIN, attempts })]);
    const seen = network({ gemini: "ok" });
    await run();
    expect(seen.gemini).toBe(1);
  });

  it("a run copied by the dedupe short-circuit", async () => {
    H.svc = makeSvc([runRow({ finishedAt: H.now - 2 * MIN, attempts: f0e2b29aAttempts(), status: "ok", statusReason: "dedupe_hit" })]);
    const seen = network({ gemini: "ok" });
    await run();
    expect(seen.gemini).toBe(1);
  });

  it("an explicit engine chosen by the operator", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    const seen = network({ gemini: "ok" });
    const settings = withEngineOverride({ tenant_id: "t1", docai_provider_order: ORDER, docai_fallback_confidence: 0.85 }, "gemini");
    const out = await run({ settings });
    expect(seen.gemini).toBe(1);
    expect(attempt(out, "gemini").status).toBe("ok");
    expect(out.adapter_used).toBe("gemini");
  });

  it("N=0 disables it", async () => {
    process.env.DOCAI_BREAKER_MINUTES = "0";
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    const seen = network({ gemini: "ok" });
    const out = await run();
    expect(seen.gemini).toBe(1);
    expect(out.adapter_used).toBe("gemini");
    expect(H.svc.queries).toHaveLength(0);
  });
});

describe("half-open after N minutes", () => {
  it("tries Gemini once, and a success closes the breaker", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 11 * MIN)]);
    let seen = network({ gemini: "ok", geminiMs: 2000 });
    const out = await run();
    expect(seen.gemini).toBe(1);
    expect(attempt(out, "gemini").breaker).toBe("half_open");
    expect(out.adapter_used).toBe("gemini");

    // The next run, inside the cache window, sees the success at once.
    H.now += 5000;
    seen = network({ gemini: "ok", geminiMs: 2000 });
    const next = await run();
    expect(seen.gemini).toBe(1);
    expect(attempt(next, "gemini").status).toBe("ok");
    expect(attempt(next, "gemini").breaker).toBeUndefined();
    expect(H.svc.queries).toHaveLength(1);
  });

  it("lets one request make the trial while a concurrent one goes on to Claude", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 11 * MIN)]);
    const seen = network({ gemini: "ok", geminiMs: 2000 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(seen.gemini).toBe(1);
    const statuses = [attempt(a, "gemini"), attempt(b, "gemini")].map((x) => x.breaker || x.reason);
    expect(statuses.sort()).toEqual(["half_open", "half_open_trial_in_flight"]);
  });

  it("opens again for N minutes when the trial is overloaded too", async () => {
    const start = H.now;
    H.svc = makeSvc([overloadedRun(start - 11 * MIN)]);
    let seen = network({ geminiMs: 4000 });
    const out = await run();
    // The trial: the primary model and the fallback model, both overloaded,
    // and each model call now says so itself.
    expect(seen.gemini).toBe(2);
    expect(attempt(out, "gemini").breaker).toBe("half_open");
    expect(attempt(out, "gemini").models.map((m) => m.failure_class)).toEqual(["overload", "overload"]);
    const trialEndedAt = start + 8000;

    H.now += 5000;
    seen = network();
    const next = await run();
    expect(seen.gemini).toBe(0);
    const g = attempt(next, "gemini");
    expect(g.status).toBe("skipped_circuit_open");
    expect(g.last_overload_at).toBe(iso(trialEndedAt));
    expect(g.half_open_at).toBe(iso(trialEndedAt + 10 * MIN));
  });
});

describe("the per-instance cache", () => {
  it("avoids a second query inside 30s and queries again after it", async () => {
    H.svc = makeSvc([overloadedRun(H.now - 2 * MIN)]);
    network();
    await run();
    H.now += 10_000;
    await run();
    expect(H.svc.queries).toHaveLength(1);
    H.now += breaker.CACHE_TTL_MS;
    await run();
    expect(H.svc.queries).toHaveLength(2);
    // Scoped to the tenant on every query.
    expect(H.svc.queries.every((f) => f.some(([op, col, val]) => op === "eq" && col === "tenant_id" && val === "t1"))).toBe(true);
  });
});

describe("overloadedOnEveryModel", () => {
  it("needs each model's last call to be an overload", () => {
    const base = { adapter: "gemini", status: "failed", failure_class: "overload" };
    expect(breaker.overloadedOnEveryModel(base)).toBe(true);
    expect(breaker.overloadedOnEveryModel({
      ...base,
      models: [
        { model: "a", status: 500, failure_class: "server_error" },
        { model: "a", status: 503, failure_class: "overload" },
        { model: "b", status: 503, failure_class: "overload" },
      ],
    })).toBe(true);
    expect(breaker.overloadedOnEveryModel({
      ...base,
      models: [{ model: "a", status: 503, failure_class: "overload" }, { model: "b", status: 500, failure_class: "server_error" }],
    })).toBe(false);
  });
});

// LLM_MIN_ATTEMPT_MS is imported so a change to the floor that would make the
// numbers above meaningless fails here first.
it("the slots above sit above Claude's floor", () => {
  expect(20_000 - PARSER_FLOOR_MS).toBeGreaterThan(LLM_MIN_ATTEMPT_MS);
});
