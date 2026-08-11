// Adapter-attempt observability + the LlamaParse v2 config contract.
//
// Both defects surfaced while diagnosing a real failed run on PO 0066026562,
// where three adapters failed and the diagnostics could not say why any did:
//
//   - dispatchExtract recorded a failed attempt as {adapter, status, ms,
//     confidence} and DROPPED the adapter's own reason/error. The run-level
//     `error` is overwritten by whichever adapter ran last, so Claude's
//     47-second failure left no trace at all — the only surviving message
//     belonged to LlamaParse, three adapters later.
//   - LlamaParse v2 requires BOTH `tier` and `version`; the adapter sent only
//     `tier`, so every call 400'd with
//     "LlamaParseMultipartConfiguration / version / Field required".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Permissive chainable Supabase stub: the dispatcher's budget guard + usage
// counter both go through it and neither is under test here.
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
vi.mock("../api/_lib/docai/adapter-learning.js", () => ({
  rankAdaptersForCustomer: async ({ order }) => order,
}));
vi.mock("../api/_lib/docai/pdf-metadata.js", () => ({
  readPdfBias: async () => null,
  composeOrderWithBias: (order) => order,
}));
// Stand-in for any real adapter in the registry; `unstructured` is chosen so
// the llamaparse module stays unmocked for the version assertions below.
vi.mock("../api/_lib/docai/unstructured.js", () => ({
  isConfigured: () => true,
  extract: vi.fn(),
}));
// A second stand-in so a test can reproduce the real outage shape: one adapter
// hard-fails, a LATER one returns a weak success and becomes `last`.
vi.mock("../api/_lib/docai/docling.js", () => ({
  isConfigured: () => true,
  extract: vi.fn(),
}));

import { dispatchExtract } from "../api/_lib/docai/index.js";
import * as unstructured from "../api/_lib/docai/unstructured.js";
import * as docling from "../api/_lib/docai/docling.js";
import { __test__ as llama } from "../api/_lib/docai/llamaparse.js";

describe("LlamaParse v2 requires tier AND version", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("defaults version to 'latest' so the call is not rejected", () => {
    delete process.env.LLAMAPARSE_VERSION;
    expect(llama.parseVersion()).toBe("latest");
  });

  it("honours a pinned dated version for reproducible parses", () => {
    process.env.LLAMAPARSE_VERSION = "2026-01-08";
    expect(llama.parseVersion()).toBe("2026-01-08");
  });

  it("still defaults the tier to agentic", () => {
    delete process.env.LLAMAPARSE_TIER;
    expect(llama.tier()).toBe("agentic");
  });
});

describe("dispatchExtract records WHY an adapter failed", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const runWith = async (adapterResult) => {
    unstructured.extract.mockResolvedValueOnce(adapterResult);
    return dispatchExtract({
      source: { bytes: Buffer.from("%PDF-1.4 x"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" },
      settings: { tenant_id: "t1", docai_provider_order: ["unstructured"] },
      customerId: null,
      hints: {},
    });
  };

  const attemptFor = (out) => (out.attempts || []).find((a) => a.adapter === "unstructured");

  it("carries the adapter's reason and error onto the failed attempt", async () => {
    const out = await runWith({
      ok: false,
      reason: "upstream_error",
      error: "400 Invalid configuration: version Field required",
    });
    const attempt = attemptFor(out);
    expect(attempt).toBeTruthy();
    expect(attempt.status).toBe("failed");
    // Both were undefined before the fix — this is the whole point.
    expect(attempt.reason).toBe("upstream_error");
    expect(attempt.error).toContain("version Field required");
  });

  it("truncates a runaway error so one adapter cannot bloat the run row", async () => {
    const out = await runWith({ ok: false, reason: "boom", error: "x".repeat(5000) });
    expect(attemptFor(out).error.length).toBe(500);
  });

  it("adds no reason/error keys to a successful attempt", async () => {
    const out = await runWith({
      ok: true,
      normalized: { classification: "po", customer: { name: "Acme" }, lines: [{ partNumber: "X", quantity: 1 }] },
      confidences: { overall: 0.95 },
    });
    const attempt = attemptFor(out);
    expect(attempt.status).toBe("ok");
    expect(attempt).not.toHaveProperty("reason");
    expect(attempt).not.toHaveProperty("error");
  });
});

// The 2026-08-10 all-providers outage: Gemini 400'd on its schema and Claude
// timed out, but LlamaParse then returned a weak ok:true, became the
// dispatcher's `last`, and run.js persisted `error: out?.error || null` — NULL.
// The run row read "low confidence · review" with no error while every real
// extractor was down. The per-adapter errors must reach the RUN, not just
// adapter_attempts.
describe("dispatchExtract lifts real failures onto the run", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // gemini runs before unstructured in the pinned order; both are mocked at the
  // registry level via the module mocks above / below.
  const runOrder = async (order) => dispatchExtract({
    source: { bytes: Buffer.from("%PDF-1.4 x"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" },
    settings: { tenant_id: "t1", docai_provider_order: order },
    customerId: null,
    hints: {},
  });

  // The exact outage shape: a hard failure, then a weak success that wins
  // `last` and would otherwise erase it from the run row.
  it("keeps an earlier hard failure visible when a weak success runs last", async () => {
    unstructured.extract.mockResolvedValueOnce({
      ok: false, reason: "upstream_error", error: "did not respond within 15000ms",
    });
    docling.extract.mockResolvedValueOnce({
      ok: true,
      normalized: { classification: "po", customer: null, lines: [{ partNumber: "X", quantity: 1 }] },
      confidences: { overall: 0.4 }, // below threshold -> becomes `last`
    });
    const out = await runOrder(["unstructured", "docling"]);
    // `last` is docling, which carries no error of its own — so before the fix
    // run.js persisted error: null and the timeout vanished from the run.
    expect(out.adapter_used).toBe("docling");
    expect(out.error).toContain("unstructured");
    expect(out.error).toContain("did not respond within 15000ms");
    expect(out.adapter_failures).toEqual([
      { adapter: "unstructured", reason: "upstream_error", error: "did not respond within 15000ms" },
    ]);
  });

  it("keeps the failing adapter's own error when it is the last one", async () => {
    unstructured.extract.mockResolvedValueOnce({
      ok: false, reason: "upstream_error", error: "did not respond within 15000ms",
    });
    const out = await runOrder(["unstructured"]);
    expect(out.error).toBe("did not respond within 15000ms");
    expect(out.adapter_failures).toHaveLength(1);
  });

  it("does not invent an error when nothing hard-failed", async () => {
    unstructured.extract.mockResolvedValueOnce({
      ok: true,
      normalized: { classification: "po", customer: null, lines: [{ partNumber: "X", quantity: 1 }] },
      confidences: { overall: 0.5 }, // below threshold -> falls through as `last`
    });
    const out = await runOrder(["unstructured"]);
    expect(out).not.toHaveProperty("adapter_failures");
    expect(out.error).toBeUndefined();
  });
});
