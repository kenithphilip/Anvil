// The 2026-10-07 run, replayed through the real dispatcher, Gemini adapter and
// Claude adapter, with only the network and the clock stubbed.
//
// What happened: a 6-page PO, tenant order [gemini, docling, marker,
// unstructured, azure_di, reducto, claude], with LlamaParse appended as the
// configured last resort. Gemini's model answered 503 "high demand" twice
// (about 8s each), the run budget stopped the third call, and the error said
// "run budget exhausted before Gemini call". Claude then got a 5,525ms attempt
// (its 13.5s slice minus a second 8s reserve) and timed out. LlamaParse read
// the PO without its header and with every item split into four lines.
//
// What must happen now:
//   - Gemini tries its fallback model on the overload and hands back quickly,
//     naming the 503;
//   - Claude gets an attempt of useful length (its configured ceiling), or,
//     when the run truly has no room, is SKIPPED with a status that says so;
//   - when every LLM failed for transient reasons and a parser read the PO,
//     the run carries the llm_unavailable_fallback_parse marker.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ fetch: null, now: 0 }));

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
vi.mock("../api/_lib/safe-fetch.js", () => ({ safeFetch: (url, init) => H.fetch(url, init) }));
vi.mock("../api/_lib/docai/adapter-learning.js", () => ({ rankAdaptersForCustomer: async ({ defaultOrder }) => defaultOrder }));
vi.mock("../api/_lib/docai/pdf-metadata.js", () => ({ readPdfBias: async () => null, composeOrderWithBias: (o) => o }));
// The tenant's other parsers have no keys, exactly as in production.
for (const m of ["docling", "marker", "unstructured", "azure_di", "reducto"]) {
  vi.doMock("../api/_lib/docai/" + m + ".js", () => ({ isConfigured: () => false, extract: vi.fn() }));
}
// The configured last resort. Its own parsing is not under test here.
vi.mock("../api/_lib/docai/llamaparse.js", () => ({
  isConfigured: () => true,
  extract: vi.fn(async () => ({
    ok: true,
    reason: "ok",
    normalized: {
      classification: "po",
      customer: null,
      lines: Array.from({ length: 24 }, (_, i) => ({ partNumber: "ROW-" + i, quantity: i % 4 ? null : 1 })),
    },
    confidences: { overall: 0.6 },
  })),
}));

const { dispatchExtract, LLM_MIN_ATTEMPT_MS } = await import("../api/_lib/docai/index.js");
const { llmUnavailableFallback, llmUnavailableAnomaly } = await import("../api/_lib/docai/llm-fallback.js");
const llamaparse = await import("../api/_lib/docai/llamaparse.js");

const ORDER = ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
const PO_TEXT = "PURCHASE ORDER\nPO No: 4500012345\nBuyer: Fixture Motors Pvt Ltd\n1 ZX-1001 GUIDE BLOCK 4 NOS 250.00\n";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
const overload = {
  error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary.", status: "UNAVAILABLE" },
};
const claudeAnswer = {
  content: [{
    type: "tool_use",
    name: "extract_purchase_order",
    input: {
      classification: "po",
      confidence: 0.93,
      customer: { name: "Fixture Motors Pvt Ltd", po_number: "4500012345", currency: "INR" },
      lines: [{ partNumber: "ZX-1001", description: "GUIDE BLOCK", quantity: 4, unitPrice: 250, uom: "NOS" }],
    },
  }],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 10 },
};

const isGemini = (url) => String(url).includes("generativelanguage");
const isClaude = (url) => String(url).includes("api.anthropic.com");
const geminiModel = (url) => decodeURIComponent(String(url).split("/models/")[1].split(":")[0]);

const run = (budgetMs) => dispatchExtract({
  source: { bytes: Buffer.from("%PDF-1.4 fixture"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" },
  settings: { tenant_id: "t1", docai_provider_order: ORDER, docai_fallback_confidence: 0.85 },
  hints: {
    deadlineAt: H.now + budgetMs,
    bodyText: PO_TEXT,
    // Six pages routes Gemini to the reasoning tier (po_multipage), the model
    // that was overloaded.
    textLayer: { status: "has_text", char_count: PO_TEXT.length, page_count: 6 },
  },
});

const saved = {};
beforeEach(() => {
  for (const k of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_MODEL_FALLBACK"]) saved[k] = process.env[k];
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  delete process.env.GEMINI_MODEL_FALLBACK;
  H.now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => H.now);
  vi.mocked(llamaparse.extract).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
});

// At Gemini's start on 10-07 the run had about 39.4s left (5.6s went on the
// text layer and the rest of the preamble).
const REMAINING_AT_DISPATCH = 39_400;

describe("an overloaded Gemini on the 10-07 PO", () => {
  it("falls back inside Gemini, names the 503, and leaves Claude a useful attempt that reads the PO", async () => {
    const claudeTimeouts = [];
    H.fetch = async (url, init) => {
      if (isGemini(url)) { H.now += 8000; return response(503, overload); }
      if (isClaude(url)) { claudeTimeouts.push(init.timeoutMs); H.now += 9000; return response(200, claudeAnswer); }
      throw new Error("unexpected fetch " + url);
    };
    const out = await run(REMAINING_AT_DISPATCH);

    const gemini = out.attempts.find((a) => a.adapter === "gemini");
    expect(gemini.status).toBe("failed");
    expect(gemini.failure_class).toBe("overload");
    expect(gemini.transient).toBe(true);
    expect(gemini.error).toMatch(/^503 model overloaded \(high demand\) on /);
    expect(gemini.error).not.toMatch(/budget exhausted/);
    // The primary, then a different model, and no third call.
    expect(gemini.models).toHaveLength(2);
    expect(gemini.models[0].model).not.toBe(gemini.models[1].model);

    // 5,525ms before. Now Claude's whole configured ceiling.
    expect(claudeTimeouts).toHaveLength(1);
    expect(claudeTimeouts[0]).toBeGreaterThanOrEqual(15_000);
    expect(out.ok).toBe(true);
    expect(out.adapter_used).toBe("claude");
    expect(out.normalized.customer.name).toBe("Fixture Motors Pvt Ltd");
    expect(llamaparse.extract).not.toHaveBeenCalled();
  });

  it("still leaves Claude a useful attempt when Gemini uses its whole slice", async () => {
    // The 10-07 shape: Gemini spends everything it is given (here a 503, then
    // the fallback model hanging to its timeout). What Claude gets is then
    // exactly what the dispatcher held back for it.
    const claudeTimeouts = [];
    let geminiCalls = 0;
    H.fetch = async (url, init) => {
      if (isGemini(url)) {
        geminiCalls += 1;
        if (geminiCalls === 1) { H.now += 8000; return response(503, overload); }
        H.now += init.timeoutMs;
        throw new Error("Upstream generativelanguage.googleapis.com did not respond within " + init.timeoutMs + "ms");
      }
      if (isClaude(url)) { claudeTimeouts.push(init.timeoutMs); H.now += 9000; return response(200, claudeAnswer); }
      throw new Error("unexpected fetch " + url);
    };
    const out = await run(REMAINING_AT_DISPATCH);

    expect(out.attempts.find((a) => a.adapter === "gemini").failure_class).toBe("timeout");
    // Before: 5,525ms. The reserve for a queued LLM is now its configured
    // ceiling (subject to the 50% cap), and no second 8s comes off it.
    expect(claudeTimeouts).toHaveLength(1);
    expect(claudeTimeouts[0]).toBeGreaterThanOrEqual(13_000);
    expect(out.adapter_used).toBe("claude");
  });

  it("uses the fallback model's answer when only the primary is overloaded", async () => {
    const asked = [];
    H.fetch = async (url) => {
      if (!isGemini(url)) throw new Error("only Gemini should be called");
      asked.push(geminiModel(url));
      H.now += 3000;
      if (asked.length === 1) return response(503, overload);
      return response(200, {
        candidates: [{
          content: { parts: [{ text: JSON.stringify(claudeAnswer.content[0].input) }] },
          finishReason: "STOP",
        }],
      });
    };
    const out = await run(REMAINING_AT_DISPATCH);
    expect(out.ok).toBe(true);
    expect(out.adapter_used).toBe("gemini");
    expect(asked).toHaveLength(2);
    expect(out.selected_model).toBe(asked[1]);
    expect(out.model_fallback_from).toBe(asked[0]);
  });
});

describe("when Claude is busy too", () => {
  it("lets the parser read the PO, and marks the run so the operator knows to retry later", async () => {
    H.fetch = async (url, init) => {
      if (isGemini(url)) { H.now += 8000; return response(503, overload); }
      if (isClaude(url)) {
        H.now += init.timeoutMs;
        throw new Error("Upstream api.anthropic.com did not respond within " + init.timeoutMs + "ms");
      }
      throw new Error("unexpected fetch " + url);
    };
    const out = await run(REMAINING_AT_DISPATCH);

    expect(out.ok).toBe(true);
    expect(out.adapter_used).toBe("llamaparse");
    const claude = out.attempts.find((a) => a.adapter === "claude");
    expect(claude.status).toBe("failed");
    expect(claude.failure_class).toBe("timeout");
    expect(claude.transient).toBe(true);

    const marker = llmUnavailableFallback({ ok: out.ok, adapterUsed: out.adapter_used, attempts: out.attempts });
    expect(marker.adapter).toBe("llamaparse");
    expect(marker.llm_attempts.map((a) => [a.adapter, a.failure_class])).toEqual([
      ["gemini", "overload"], ["claude", "timeout"],
    ]);
    expect(llmUnavailableAnomaly(marker).code).toBe("llm_unavailable_fallback_parse");
  });
});

describe("when the run has no room for a useful Claude attempt", () => {
  it("skips Claude with skipped_insufficient_budget instead of starting a call it cannot finish", async () => {
    let claudeCalls = 0;
    H.fetch = async (url) => {
      if (isGemini(url)) { H.now += 4000; return response(503, overload); }
      if (isClaude(url)) { claudeCalls += 1; return response(200, claudeAnswer); }
      throw new Error("unexpected fetch " + url);
    };
    // 20s left at dispatch: Gemini's two overloads take 8s, and what remains
    // after LlamaParse's floor is under half of Claude's ceiling.
    const out = await run(20_000);

    expect(claudeCalls).toBe(0);
    const claude = out.attempts.find((a) => a.adapter === "claude");
    expect(claude.status).toBe("skipped_insufficient_budget");
    expect(claude.reason).toBe("llm_attempt_would_be_too_short");
    expect(claude.needed_ms).toBe(LLM_MIN_ATTEMPT_MS);
    expect(claude.available_ms).toBeLessThan(claude.needed_ms);
    expect(out.adapter_used).toBe("llamaparse");
    // Busy Gemini plus a Claude with no time left is still "the models were busy".
    expect(llmUnavailableFallback({ ok: out.ok, adapterUsed: out.adapter_used, attempts: out.attempts })).not.toBeNull();
  });
});
