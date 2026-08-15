// A success must survive anything that runs after it.
//
// Observed in production on PO 0066026562: LlamaParse returned a complete parse
// at confidence 0.82. That is under the 0.85 fallback threshold, so the loop
// continued; Gemini and Claude then both died on "run budget exhausted", and
// because `last` was reassigned every iteration, Claude's failure BECAME the
// run. It persisted raw_extract: null, normalized_extract: null and reported
// `failed` — discarding a working extraction and, with it, the evidence needed
// to explain why that run produced 6 lines where an earlier one produced 44.
//
// Falling through to a fallback is an attempt to do better. It is never a
// reason to throw away what we already have.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
// Three stand-ins so a chain can be composed in any order. The real llamaparse
// / gemini / claude modules stay unmocked so nothing here depends on them.
vi.mock("../api/_lib/docai/unstructured.js", () => ({ isConfigured: () => true, extract: vi.fn() }));
vi.mock("../api/_lib/docai/docling.js", () => ({ isConfigured: () => true, extract: vi.fn() }));
vi.mock("../api/_lib/docai/marker.js", () => ({ isConfigured: () => true, extract: vi.fn() }));

import { dispatchExtract, isBetterResult } from "../api/_lib/docai/index.js";
import * as first from "../api/_lib/docai/unstructured.js";
import * as second from "../api/_lib/docai/docling.js";
import * as third from "../api/_lib/docai/marker.js";

const CHAIN = ["unstructured", "docling", "marker"];
const run = () => dispatchExtract({
  source: { bytes: Buffer.from("%PDF-1.4 x"), mime: "application/pdf", filename: "po.pdf", sourceType: "pdf" },
  settings: { tenant_id: "t1", docai_provider_order: CHAIN, docai_fallback_confidence: 0.85 },
});

// Confidence is averaged across the map, so a single entry sets it exactly.
const okResult = (conf, lineCount, raw = null) => ({
  ok: true,
  normalized: { classification: "po", lines: Array.from({ length: lineCount }, (_, i) => ({ partNumber: "PN-" + i, quantity: 1, unitPrice: 10 })) },
  confidences: { overall: conf },
  reason: "ok",
  ...(raw ? { raw } : {}),
});
const failResult = (error, raw = null) => ({ ok: false, reason: "upstream_error", error, ...(raw ? { raw } : {}) });

beforeEach(() => { vi.clearAllMocks(); });

describe("a later failure cannot discard an earlier success", () => {
  it("returns the low-confidence success, not the trailing failure", async () => {
    // The exact production shape.
    first.extract.mockResolvedValueOnce(okResult(0.82, 44));
    second.extract.mockResolvedValueOnce(failResult("run budget exhausted before Gemini call"));
    third.extract.mockResolvedValueOnce(failResult("run budget exhausted before Anthropic call"));

    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.adapter_used).toBe("unstructured");
    expect(out.normalized.lines).toHaveLength(44);
    expect(out.confidence_overall).toBeCloseTo(0.82, 5);
  });

  it("still surfaces what failed after it, so the fallbacks' errors are not hidden", async () => {
    first.extract.mockResolvedValueOnce(okResult(0.82, 44));
    second.extract.mockResolvedValueOnce(failResult("gemini exploded"));
    third.extract.mockResolvedValueOnce(failResult("claude exploded"));

    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.adapter_failures.map((f) => f.adapter)).toEqual(["docling", "marker"]);
    expect(out.attempts).toHaveLength(3);
  });

  it("keeps failure behaviour unchanged when nothing succeeds", async () => {
    first.extract.mockResolvedValueOnce(failResult("a failed"));
    second.extract.mockResolvedValueOnce(failResult("b failed"));
    third.extract.mockResolvedValueOnce(failResult("c failed"));

    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.adapter_used).toBe("marker");     // the last failure, as before
  });

  it("returns immediately on a confident result without running the rest", async () => {
    first.extract.mockResolvedValueOnce(okResult(0.95, 44));
    const out = await run();
    expect(out.ok).toBe(true);
    expect(second.extract).not.toHaveBeenCalled();
    expect(third.extract).not.toHaveBeenCalled();
  });
});

describe("choosing between two under-threshold successes", () => {
  it("prefers the one that actually produced lines", async () => {
    first.extract.mockResolvedValueOnce(okResult(0.84, 0));
    second.extract.mockResolvedValueOnce(okResult(0.60, 44));
    third.extract.mockResolvedValueOnce(failResult("c failed"));

    const out = await run();
    expect(out.adapter_used).toBe("docling");
    expect(out.normalized.lines).toHaveLength(44);
  });

  it("prefers higher confidence when both produced lines", async () => {
    first.extract.mockResolvedValueOnce(okResult(0.60, 10));
    second.extract.mockResolvedValueOnce(okResult(0.80, 10));
    third.extract.mockResolvedValueOnce(failResult("c failed"));

    const out = await run();
    expect(out.adapter_used).toBe("docling");
  });

  it("keeps the incumbent on a dead tie, preserving the tenant's provider order", async () => {
    first.extract.mockResolvedValueOnce(okResult(0.70, 10));
    second.extract.mockResolvedValueOnce(okResult(0.70, 10));
    third.extract.mockResolvedValueOnce(failResult("c failed"));

    const out = await run();
    expect(out.adapter_used).toBe("unstructured");
  });
});

describe("isBetterResult", () => {
  const r = (conf, lines) => ({ ok: true, confidence_overall: conf, normalized: { lines: new Array(lines).fill({}) } });

  it("takes any success over nothing", () => {
    expect(isBetterResult(r(0.1, 0), null)).toBe(true);
  });

  it("never lets a failure win", () => {
    expect(isBetterResult({ ok: false, confidence_overall: 0.99 }, r(0.1, 1))).toBe(false);
  });

  // Confidence scores the fields that ARE present and says nothing about the
  // ones that are missing, so it cannot outrank having lines at all.
  it("ranks 44 lines at 0.82 above 0 lines at 0.90", () => {
    expect(isBetterResult(r(0.82, 44), r(0.90, 0))).toBe(true);
    expect(isBetterResult(r(0.90, 0), r(0.82, 44))).toBe(false);
  });

  it("uses line count as the final tie-break", () => {
    expect(isBetterResult(r(0.8, 20), r(0.8, 10))).toBe(true);
    expect(isBetterResult(r(0.8, 10), r(0.8, 20))).toBe(false);
  });

  it("treats a missing confidence as worse than any real score", () => {
    expect(isBetterResult(r(undefined, 5), r(0.1, 5))).toBe(false);
  });
});

describe("raw output is salvaged for diagnosis", () => {
  it("keeps the parsed document from a FAILED adapter when the run has none", async () => {
    // LlamaParse's empty_lines failure carries the full markdown it parsed.
    // Losing it is what made the 6-lines-vs-44 question unanswerable.
    first.extract.mockResolvedValueOnce(failResult("no parsable line-item table", { markdown: "# PO\n<table>…</table>", chars: 45842 }));
    second.extract.mockResolvedValueOnce(failResult("b failed"));
    third.extract.mockResolvedValueOnce(failResult("c failed"));

    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.raw?.chars).toBe(45842);
    expect(out.raw_adapter).toBe("unstructured");   // whose raw it is, never mislabelled
  });

  it("never overwrites the chosen result's own raw", async () => {
    first.extract.mockResolvedValueOnce(failResult("early", { markdown: "EARLY" }));
    second.extract.mockResolvedValueOnce({ ...okResult(0.82, 5), raw: { markdown: "CHOSEN" } });
    third.extract.mockResolvedValueOnce(failResult("late"));

    const out = await run();
    expect(out.raw.markdown).toBe("CHOSEN");
    expect(out.raw_adapter).toBeUndefined();
  });

  it("adds nothing when no adapter produced raw output", async () => {
    first.extract.mockResolvedValueOnce(failResult("a"));
    second.extract.mockResolvedValueOnce(failResult("b"));
    third.extract.mockResolvedValueOnce(failResult("c"));

    const out = await run();
    expect(out.raw).toBeUndefined();
    expect(out.raw_adapter).toBeUndefined();
  });
});
