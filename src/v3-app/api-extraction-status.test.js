// Unit tests for the extraction_status summariser.

import { describe, it, expect } from "vitest";
import { __test } from "../api/orders/extraction_status.js";

const evt = (event_type, detail, created_at) => ({
  event_type,
  detail: detail || {},
  created_at: created_at || new Date().toISOString(),
  duration_ms: null,
});

describe("__test.stageLabel", () => {
  it("returns idle when there is no event", () => {
    expect(__test.stageLabel(null)).toBe("idle");
  });
  it("renders chunk progress with index + total", () => {
    const out = __test.stageLabel(evt("docai_chunk_chunk_started", { chunk_index: 1, chunk_count: 5, page_start: 6, page_end: 10 }));
    expect(out).toContain("chunk 2 of 5");
    expect(out).toContain("pages 6-10");
  });
  it("renders done with line count", () => {
    expect(__test.stageLabel(evt("docai_chunk_done", { line_count: 18 })))
      .toBe("done · 18 lines extracted");
    expect(__test.stageLabel(evt("docai_chunk_done", { line_count: 1 })))
      .toBe("done · 1 line extracted");
  });
  it("renders profiler done with line-item page count", () => {
    const out = __test.stageLabel(evt("docai_profiler_done", { ok: true, line_item_pages: [3, 4, 11] }));
    expect(out).toContain("3 line-item pages identified");
  });
  it("renders chunk_failed with the upstream error", () => {
    expect(__test.stageLabel(evt("docai_chunk_chunk_failed", { error: "upstream timeout" })))
      .toContain("upstream timeout");
  });
});

describe("__test.summarise", () => {
  it("returns idle status when there are no events", () => {
    const s = __test.summarise([]);
    expect(s.status).toBe("idle");
    expect(s.chunks_total).toBe(0);
  });

  it("tracks a full profile + chunk run end-to-end (events ordered newest first)", () => {
    // The endpoint sorts events newest-first; the summariser
    // iterates in event order regardless, so we reverse to mirror
    // the same order the endpoint feeds in.
    const events = [
      // Newest first
      evt("docai_extract_completed", { line_count: 18 }),
      evt("docai_chunk_done", { line_count: 18, chunk_count: 2 }),
      evt("docai_chunk_chunk_done", { chunk_index: 1, chunk_count: 2, adapter_used: "claude" }),
      evt("docai_chunk_chunk_started", { chunk_index: 1, chunk_count: 2, page_start: 4, page_end: 5 }),
      evt("docai_chunk_chunk_done", { chunk_index: 0, chunk_count: 2, adapter_used: "claude" }),
      evt("docai_chunk_chunk_started", { chunk_index: 0, chunk_count: 2, page_start: 3, page_end: 3 }),
      evt("docai_chunk_chunking_complete", { page_count: 70, chunk_count: 2 }),
      evt("docai_profiler_done", { ok: true, line_item_pages: [3, 4, 5], page_count: 70 }),
      evt("docai_profiler_started", { page_count: 70 }),
      evt("docai_extract_started", {}),
    ];
    const s = __test.summarise(events);
    expect(s.status).toBe("completed");
    expect(s.page_count).toBe(70);
    expect(s.line_item_pages).toEqual([3, 4, 5]);
    expect(s.chunks_total).toBe(2);
    expect(s.chunks_done).toBe(2);
    expect(s.line_count).toBe(18);
    expect(s.adapters_used).toEqual(["claude"]);
    expect(s.profiler_ok).toBe(true);
    expect(s.current_stage).toContain("complete");
  });

  it("flags failed status when a terminal failure event lands", () => {
    const events = [
      evt("docai_extract_failed", { error: "upstream timeout" }),
      evt("docai_extract_started", {}),
    ];
    const s = __test.summarise(events);
    expect(s.status).toBe("failed");
    expect(s.last_terminal_reason).toBe("upstream timeout");
  });

  it("counts failed chunks separately from done chunks", () => {
    const events = [
      evt("docai_chunk_chunk_done", { chunk_index: 0, chunk_count: 3, adapter_used: "claude" }),
      evt("docai_chunk_chunk_failed", { chunk_index: 1, chunk_count: 3, error: "rate_limit" }),
      evt("docai_chunk_chunk_done", { chunk_index: 2, chunk_count: 3, adapter_used: "gemini" }),
      evt("docai_chunk_chunking_complete", { chunk_count: 3 }),
      evt("docai_extract_started", {}),
    ];
    const s = __test.summarise(events);
    expect(s.chunks_done).toBe(2);
    expect(s.chunks_failed).toBe(1);
    expect(s.chunks_total).toBe(3);
  });
});
