// Unit tests for src/api/_lib/docai/chunked-extract.js.
//
// dispatchExtract is mocked so the orchestrator can be driven
// end-to-end against synthetic PDFs without standing up Claude /
// Gemini credentials.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(),
}));

import { dispatchExtract } from "../api/_lib/docai/index.js";
import {
  chunkedExtract,
  mergeChunkResults,
  CHUNK_PAGE_THRESHOLD,
  __test,
} from "../api/_lib/docai/chunked-extract.js";

const makePdf = async (pages) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return doc.save();
};

// A dispatchExtract result. Production nests classification/customer/lines
// under `.normalized`; overrides targeting those route into normalized, the
// rest (adapter_used, confidence_overall, selected_model, reason, attempts…)
// stay top level.
const ok = (overrides = {}) => {
  const { classification, customer, lines, ...rest } = overrides;
  return {
    ok: true, adapter_used: "claude", latency_ms: 100,
    confidences: { customer: 0.9, lines: 0.85 }, confidence_overall: 0.87, attempts: [],
    normalized: {
      classification: classification !== undefined ? classification : "po",
      customer: customer !== undefined ? customer : { name: "ACME Pvt Ltd" },
      lines: lines !== undefined ? lines : [{ partNumber: "X-1", quantity: 1 }],
    },
    ...rest,
  };
};

beforeEach(() => { vi.clearAllMocks(); });

describe("__test.isPdfSource", () => {
  it("recognises PDFs by mime", () => {
    expect(__test.isPdfSource({ mime: "application/pdf" })).toBe(true);
    expect(__test.isPdfSource({ mime: "image/png" })).toBe(false);
  });
  it("recognises PDFs by filename extension", () => {
    expect(__test.isPdfSource({ filename: "po.pdf" })).toBe(true);
    expect(__test.isPdfSource({ filename: "po.xlsx" })).toBe(false);
  });
  it("handles a missing source", () => {
    expect(__test.isPdfSource(null)).toBe(false);
  });
});

describe("__test.toBytes", () => {
  it("returns Uint8Array as-is", () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(__test.toBytes({ bytes: u })).toBe(u);
  });
  it("decodes a base64 string", () => {
    const b64 = Buffer.from([4, 5, 6]).toString("base64");
    const out = __test.toBytes({ bytes: b64 });
    expect(Array.from(out)).toEqual([4, 5, 6]);
  });
});

describe("chunkedExtract", () => {
  it("passes a short PDF straight through (no chunking)", async () => {
    const bytes = await makePdf(CHUNK_PAGE_THRESHOLD - 2);
    dispatchExtract.mockResolvedValueOnce(ok());
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf", filename: "short.pdf" },
    });
    expect(out.ok).toBe(true);
    expect(out.chunked).toBeUndefined();
    expect(dispatchExtract).toHaveBeenCalledTimes(1);
  });

  it("passes a non-PDF source straight through", async () => {
    dispatchExtract.mockResolvedValueOnce(ok({ adapter_used: "excel" }));
    const out = await chunkedExtract({
      source: { bytes: new Uint8Array([1, 2, 3]), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "po.xlsx" },
    });
    expect(out.adapter_used).toBe("excel");
    expect(dispatchExtract).toHaveBeenCalledTimes(1);
  });

  it("chunks a long PDF and merges the per-chunk results", async () => {
    const bytes = await makePdf(12);
    dispatchExtract
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-1", quantity: 1 }] }))
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-2", quantity: 2 }] }))
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-3", quantity: 3 }] }));
    const events = [];
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf" },
      opts: { eventSink: (e) => events.push(e), maxPagesPerChunk: 5, pageThreshold: 6 },
    });
    expect(out.chunked).toBe(true);
    expect(out.chunk_count).toBe(3);
    expect(out.normalized.lines.length).toBe(3);
    expect(out.normalized.lines.map((l) => l.partNumber)).toEqual(["X-1", "X-2", "X-3"]);
    expect(out.normalized.lines[0]._chunk_index).toBe(0);
    expect(out.normalized.lines[0]._chunk_page_start).toBe(1);
    expect(dispatchExtract).toHaveBeenCalledTimes(3);
    // Events: chunking_started -> chunking_complete -> chunk_started/done x3 -> merging_results -> done
    const stages = events.map((e) => e.stage);
    expect(stages).toContain("chunking_started");
    expect(stages).toContain("chunking_complete");
    expect(stages.filter((s) => s === "chunk_started").length).toBe(3);
    expect(stages.filter((s) => s === "chunk_done").length).toBe(3);
    expect(stages[stages.length - 1]).toBe("done");
  });

  it("uses the TOC keepPages list to skip T&C", async () => {
    const bytes = await makePdf(20);
    dispatchExtract
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-1" }] }))
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-2" }] }));
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf" },
      opts: { keepPages: [3, 4, 11, 12], maxPagesPerChunk: 2 },
    });
    expect(out.chunked).toBe(true);
    expect(out.chunk_count).toBe(2);
    // dispatchExtract called only twice despite 20 input pages
    expect(dispatchExtract).toHaveBeenCalledTimes(2);
  });

  it("survives a failed chunk and records the error in the merged result", async () => {
    const bytes = await makePdf(10);
    dispatchExtract
      .mockResolvedValueOnce(ok({ lines: [{ partNumber: "X-1" }] }))
      .mockRejectedValueOnce(new Error("upstream timeout"));
    const events = [];
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf" },
      opts: { eventSink: (e) => events.push(e), maxPagesPerChunk: 5, pageThreshold: 6 },
    });
    expect(out.chunked).toBe(true);
    expect(out.chunk_count).toBe(2);
    // First chunk's line still present even though chunk 2 failed.
    expect(out.normalized.lines.length).toBe(1);
    expect(out.ok).toBe(true); // at least one chunk succeeded
    const failed = events.find((e) => e.stage === "chunk_failed");
    expect(failed).toBeTruthy();
    expect(failed.error).toContain("upstream timeout");
  });

  it("runs chunks concurrently but merges them in chunk order", async () => {
    // Chunk 0 resolves LAST; the merged lines must still be in chunk order,
    // proving results are placed by index, not completion order.
    const bytes = await makePdf(12); // 3 chunks @ 5pp
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    dispatchExtract.mockImplementation(async ({ hints }) => {
      const i = hints.chunk_index;
      if (i === 0) await sleep(25);
      return ok({ lines: [{ partNumber: "P" + i }] });
    });
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf" },
      opts: { maxPagesPerChunk: 5, chunkConcurrency: 4, pageThreshold: 6 },
    });
    expect(out.chunk_count).toBe(3);
    expect(out.normalized.lines.map((l) => l.partNumber)).toEqual(["P0", "P1", "P2"]);
  });

  it("stops launching waves once the per-extraction budget is blown", async () => {
    const bytes = await makePdf(15); // 3 chunks @ 5pp
    let calls = 0;
    let exceeded = false;
    dispatchExtract.mockImplementation(async ({ hints }) => {
      calls++; exceeded = true; // budget blown after the first chunk runs
      return ok({ lines: [{ partNumber: "P" + hints.chunk_index }] });
    });
    const runCost = { hasExceeded: () => exceeded, totalUsd: 1.2, cap: 1.0 };
    const events = [];
    const out = await chunkedExtract({
      source: { bytes, mime: "application/pdf" },
      runCost,
      opts: { maxPagesPerChunk: 5, chunkConcurrency: 1, eventSink: (e) => events.push(e), pageThreshold: 6 },
    });
    expect(out.chunk_count).toBe(3);
    expect(calls).toBe(1); // only chunk 0 dispatched; remaining waves skipped
    expect(out.budget_breached_at_chunk).not.toBeNull();
    expect(events.some((e) => e.stage === "chunk_skipped_over_budget")).toBe(true);
  });
});

describe("mergeChunkResults", () => {
  it("returns a single chunk's result unchanged when there is only one", () => {
    const r = ok();
    const m = mergeChunkResults([r], [{ pageStart: 1, pageEnd: 3, pageCount: 3 }]);
    expect(m.normalized.lines).toEqual(r.normalized.lines);
  });

  // Regression guard: a MULTI-chunk merge must return lines/customer/
  // classification NESTED under `.normalized` — the same shape dispatchExtract
  // (passthrough + single-chunk) returns and run.js reads via out.normalized.*.
  // The merge previously returned them at top level while reading r.lines
  // (flat) from nested chunk results, so every >1-chunk PO came back with zero
  // lines / null customer in production.
  it("returns a nested `.normalized` shape and reads lines from nested chunk results", () => {
    const m = mergeChunkResults(
      [ok({ lines: [{ partNumber: "A" }], customer: { name: "ACME" } }), ok({ lines: [{ partNumber: "B" }] })],
      [{ pageCount: 1, pageStart: 1, pageEnd: 1 }, { pageCount: 1, pageStart: 2, pageEnd: 2 }],
    );
    expect(m.lines).toBeUndefined();          // NOT top level anymore
    expect(m.normalized).toBeDefined();
    expect(m.normalized.lines.map((l) => l.partNumber)).toEqual(["A", "B"]);
    expect(m.normalized.customer).toEqual({ name: "ACME" });
    expect(m.normalized.classification).toBe("po");
  });

  it("picks po classification over non_po when any chunk found one", () => {
    const m = mergeChunkResults(
      [ok({ classification: "non_po" }), ok({ classification: "po" }), ok({ classification: "non_po" })],
      [{ pageCount: 3 }, { pageCount: 3 }, { pageCount: 3 }],
    );
    expect(m.normalized.classification).toBe("po");
  });

  it("weights confidence by chunk page count", () => {
    const m = mergeChunkResults(
      [ok({ confidence_overall: 0.9 }), ok({ confidence_overall: 0.5 })],
      [{ pageCount: 1 }, { pageCount: 9 }],
    );
    // weighted = (0.9 * 1 + 0.5 * 9) / 10 = 0.54
    expect(m.confidence_overall).toBeCloseTo(0.54, 2);
  });

  it("picks the most common adapter across chunks", () => {
    const m = mergeChunkResults(
      [ok({ adapter_used: "claude" }), ok({ adapter_used: "claude" }), ok({ adapter_used: "gemini" })],
      [{ pageCount: 3 }, { pageCount: 3 }, { pageCount: 3 }],
    );
    expect(m.adapter_used).toBe("claude");
  });

  it("aggregates attempts across chunks", () => {
    const m = mergeChunkResults(
      [ok({ attempts: [{ adapter: "claude", ms: 100 }] }), ok({ attempts: [{ adapter: "gemini", ms: 80 }] })],
      [{ pageCount: 1 }, { pageCount: 1 }],
    );
    expect(m.attempts.length).toBe(2);
    expect(m.attempts.every((a) => typeof a._chunk_index === "number")).toBe(true);
  });

  // Observability: when EVERY chunk fails, the merge must surface the real
  // reason + model instead of collapsing to fail_unknown / model — (the
  // black box operators hit on the 7-page P250432265 PO).
  const fail = (o = {}) => {
    const { lines, customer, classification, ...rest } = o;
    return { ok: false, normalized: { classification: classification ?? null, customer: customer ?? null, lines: lines || [] }, confidences: {}, attempts: [], ...rest };
  };

  it("propagates the underlying reason + selected_model when all chunks fail", () => {
    const m = mergeChunkResults(
      [
        fail({ reason: "upstream_error", error: "401 invalid x-api-key", selected_model: "claude-sonnet-4-6", model_selection_reason: "default" }),
        fail({ reason: "upstream_error", error: "401 invalid x-api-key", selected_model: "claude-sonnet-4-6" }),
      ],
      [{ pageCount: 3 }, { pageCount: 4 }],
    );
    expect(m.ok).toBe(false);
    expect(m.reason).toBe("upstream_error");            // NOT undefined -> run.js no longer shows fail_unknown
    expect(m.selected_model).toBe("claude-sonnet-4-6"); // NOT null -> diagnostics shows the model
    expect(m.model_selection_reason).toBe("default");
    expect(m.error).toContain("401");
  });

  it("carries selected_model even on a successful chunked run", () => {
    const m = mergeChunkResults(
      [ok({ selected_model: "gemini-3-flash" }), ok({ selected_model: "gemini-3-flash" })],
      [{ pageCount: 1 }, { pageCount: 1 }],
    );
    expect(m.ok).toBe(true);
    expect(m.selected_model).toBe("gemini-3-flash");
    expect(m.reason).toBeUndefined();                   // no failure reason on success
  });

  it("does not fabricate a reason when at least one chunk succeeds", () => {
    const m = mergeChunkResults(
      [ok({ lines: [{ partNumber: "X-1" }] }), fail({ reason: "upstream_error" })],
      [{ pageCount: 1 }, { pageCount: 1 }],
    );
    expect(m.ok).toBe(true);
    expect(m.reason).toBeUndefined();
  });
});
