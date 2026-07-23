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

import { dispatchExtract } from "../api/_lib/docai/index.js";
import * as unstructured from "../api/_lib/docai/unstructured.js";
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
