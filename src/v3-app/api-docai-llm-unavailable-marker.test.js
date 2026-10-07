// The llm_unavailable_fallback_parse marker.
//
// A parser read the 2026-10-07 PO because Gemini was overloaded and Claude
// timed out, and the run looked like any other weak extraction. The marker says
// "the models were busy; running extraction again later may do much better".
// It must be set exactly when that advice is honest: only when every LLM that
// could read the document failed for a transient reason (or had no time left
// because of the ones that did), and never when an LLM gave a real answer or
// failed for a reason a retry will not fix.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { llmUnavailableFallback, llmUnavailableAnomaly, LLM_UNAVAILABLE_CODE } from "../api/_lib/docai/llm-fallback.js";

const geminiOverloaded = { adapter: "gemini", status: "failed", reason: "upstream_error", failure_class: "overload", transient: true, error: "503 model overloaded (high demand) on gemini-x: busy" };
const claudeTimedOut = { adapter: "claude", status: "failed", reason: "upstream_error", failure_class: "timeout", transient: true, error: "Network error: Upstream api.anthropic.com did not respond within 15000ms" };
const parserOk = { adapter: "llamaparse", status: "low_confidence", confidence: 0.6 };
const unconfigured = (adapter) => ({ adapter, status: "skipped_not_configured" });

const mark = (attempts, adapterUsed = "llamaparse", ok = true) => llmUnavailableFallback({ ok, adapterUsed, attempts });

describe("the marker is set", () => {
  it("when Gemini was overloaded, Claude timed out, and a parser read the document", () => {
    const m = mark([geminiOverloaded, unconfigured("docling"), claudeTimedOut, parserOk]);
    expect(m.adapter).toBe("llamaparse");
    expect(m.llm_attempts.map((a) => a.adapter)).toEqual(["gemini", "claude"]);
  });

  it("when the busy LLM used up the time and the next one was skipped for it", () => {
    const m = mark([geminiOverloaded, { adapter: "claude", status: "skipped_insufficient_budget", reason: "llm_attempt_would_be_too_short" }, parserOk]);
    expect(m).not.toBeNull();
  });

  it("ignoring an LLM that has no schema for this kind of document", () => {
    const m = mark([claudeTimedOut, { adapter: "gemini", status: "failed", reason: "unsupported_kind", error: "No extraction schema for kind \"quote\" on the gemini adapter." }, parserOk]);
    expect(m.llm_attempts.map((a) => a.adapter)).toEqual(["claude"]);
  });
});

describe("the marker is not set", () => {
  it("when an LLM failed for a reason a retry will not fix", () => {
    const badRequest = { adapter: "claude", status: "failed", reason: "upstream_error", failure_class: "client_error", transient: false, error: "400 invalid request" };
    expect(mark([geminiOverloaded, badRequest, parserOk])).toBeNull();
  });

  it("when an LLM gave an answer, even a low-confidence one", () => {
    expect(mark([geminiOverloaded, { adapter: "claude", status: "low_confidence", confidence: 0.7 }, parserOk])).toBeNull();
  });

  it("when an LLM produced the result", () => {
    expect(mark([geminiOverloaded, { adapter: "claude", status: "ok", confidence: 0.93 }], "claude")).toBeNull();
  });

  it("when no LLM was configured at all", () => {
    expect(mark([unconfigured("gemini"), unconfigured("claude"), parserOk])).toBeNull();
  });

  it("when an LLM was stopped by the cost cap, not by load", () => {
    expect(mark([geminiOverloaded, { adapter: "claude", status: "skipped_over_budget", reason: "over_daily_budget" }, parserOk])).toBeNull();
  });

  it("when the run failed outright", () => {
    expect(mark([geminiOverloaded, claudeTimedOut], "llamaparse", false)).toBeNull();
  });
});

describe("the anomaly row", () => {
  it("is a warning that names the parser, the busy models, and what to do", () => {
    const a = llmUnavailableAnomaly(mark([geminiOverloaded, claudeTimedOut, parserOk]));
    expect(a.code).toBe(LLM_UNAVAILABLE_CODE);
    expect(a.severity).toBe("warn");
    expect(a.actual).toBe("llamaparse");
    expect(a.detail).toBe(
      "The AI models were busy (gemini overloaded, claude timed out), so the fallback parser (llamaparse) read this document. "
      + "Check the header and the lines. Run extraction again later for a better result.",
    );
  });
});

// ---- persisted by the pipeline ------------------------------------------------

const H = vi.hoisted(() => ({ out: null }));

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async () => ({
    ok: true, status: "has_text", page_count: 6, char_count: 40, body_text: "PURCHASE ORDER\nFixture Buyer\n",
    page_breakdown: [], extractor: "unpdf", extractor_version: "test", latency_ms: 1, error: null,
  })),
  extractTextBlocks: vi.fn(async () => null),
  contentHash: vi.fn(async () => "fixture_hash_llm_unavailable"),
}));
vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async () => ({ ok: false, status: "failed", page_count: 0, char_count: 0, body_text: null, raw_pages: [], error: "stubbed" })),
}));
vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async () => H.out),
  buildPromptOverrides: () => null,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

const { runExtractionPipeline } = await import("../api/_lib/docai/run.js");
const audit = await import("../api/_lib/audit.js");

const makeSvc = () => {
  const writes = [];
  return {
    writes,
    from(table) {
      const api = {
        select() { return api; }, eq() { return api; }, in() { return api; }, is() { return api; },
        gte() { return api; }, lte() { return api; }, order() { return api; }, limit() { return api; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        update(values) { writes.push({ table, op: "update", values }); return api; },
        upsert() { return Promise.resolve({ data: null, error: null }); },
        insert(values) {
          const row = { id: table === "extraction_runs" ? "run-1" : "id-x", ...values };
          return {
            select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
            then: (resolve) => { resolve({ data: [row], error: null }); return { catch: () => ({}) }; },
          };
        },
        then(resolve) { resolve({ data: [], error: null }); return { catch: () => ({}) }; },
      };
      return api;
    },
  };
};

const parserResult = (attempts) => ({
  ok: true,
  adapter_used: "llamaparse",
  confidence_overall: 0.6,
  confidences: { overall: 0.6 },
  normalized: { classification: "po", customer: null, lines: [{ partNumber: "ROW-1", quantity: 1, unitPrice: 10 }] },
  attempts,
  mode: "llamaparse",
});

const runPo = (svc) => runExtractionPipeline({
  ctx: { tenantId: "t1", user: { id: "u1" } },
  svc,
  settings: {},
  bytes: Buffer.from("%PDF-1.4 fake"),
  filename: "po.pdf",
  mime: "application/pdf",
  sourceType: "pdf",
  kind: "po",
});

beforeEach(() => { vi.clearAllMocks(); });

describe("runExtractionPipeline records the marker", () => {
  it("persists it with the anomalies, counts it, and records an event", async () => {
    H.out = parserResult([geminiOverloaded, claudeTimedOut, parserOk]);
    const svc = makeSvc();
    const result = await runPo(svc);

    expect(result.anomalies.map((a) => a.code)).toContain(LLM_UNAVAILABLE_CODE);
    const persisted = svc.writes.filter((w) => w.table === "extraction_runs" && w.op === "update").at(-1).values;
    expect(persisted.anomalies.find((a) => a.code === LLM_UNAVAILABLE_CODE).actual).toBe("llamaparse");
    expect(persisted.anomalies_summary.warn).toBeGreaterThanOrEqual(1);
    expect(persisted.anomalies_summary.total).toBe(persisted.anomalies.length);
    const events = audit.recordEvent.mock.calls.map((c) => c[1]?.eventType);
    expect(events).toContain("docai_llm_unavailable_fallback_parse");
  });

  it("leaves a run alone when an LLM failed for a non-transient reason", async () => {
    H.out = parserResult([
      { adapter: "gemini", status: "failed", reason: "parse_failed", error: "non-json response" },
      claudeTimedOut,
      parserOk,
    ]);
    const result = await runPo(makeSvc());
    expect(result.anomalies.map((a) => a.code)).not.toContain(LLM_UNAVAILABLE_CODE);
  });
});
