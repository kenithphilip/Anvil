// Unit tests for src/api/_lib/docai/pdf-chunker.js.
//
// We exercise the pure helpers in __test directly (no PDF
// parsing needed) and run two integration tests against
// synthetic PDFs generated via pdf-lib so the full chunkPdf()
// path runs end-to-end against a real document.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  chunkPdf,
  probePdfPageCount,
  DEFAULT_MAX_PAGES_PER_CHUNK,
  SYNC_MAX_TOTAL_PAGES,
  __test,
} from "../api/_lib/docai/pdf-chunker.js";

// Build a synthetic PDF with N blank pages we can chunk against.
const makePdf = async (pageCount) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([300, 400]);
  }
  return doc.save();
};

describe("__test.normaliseKeep", () => {
  it("returns every page when keep is empty or absent", () => {
    expect(__test.normaliseKeep(5, undefined)).toEqual([1, 2, 3, 4, 5]);
    expect(__test.normaliseKeep(5, [])).toEqual([1, 2, 3, 4, 5]);
  });
  it("drops out-of-range pages and dedupes", () => {
    expect(__test.normaliseKeep(5, [0, 1, 1, 2, 6, 7])).toEqual([1, 2]);
  });
  it("sorts the keep list", () => {
    expect(__test.normaliseKeep(5, [3, 1, 2])).toEqual([1, 2, 3]);
  });
});

describe("__test.groupIntoChunks", () => {
  it("groups contiguously", () => {
    expect(__test.groupIntoChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("never produces a zero-length group", () => {
    expect(__test.groupIntoChunks([], 3)).toEqual([]);
  });
  it("groups by index, not by page-number adjacency", () => {
    // keep=[1, 5, 6, 10] with max=2 -> [[1,5],[6,10]]
    expect(__test.groupIntoChunks([1, 5, 6, 10], 2)).toEqual([[1, 5], [6, 10]]);
  });
});

describe("probePdfPageCount", () => {
  it("counts pages from a Uint8Array", async () => {
    const bytes = await makePdf(7);
    expect(await probePdfPageCount(bytes)).toBe(7);
  });
  it("counts pages from a base64 string", async () => {
    const bytes = await makePdf(3);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(await probePdfPageCount(b64)).toBe(3);
  });
});

describe("chunkPdf", () => {
  it("splits a 12-page PDF into 3 chunks at the default chunk size", async () => {
    const bytes = await makePdf(12);
    const r = await chunkPdf(bytes);
    expect(r.totalPages).toBe(12);
    expect(r.chunks.length).toBe(Math.ceil(12 / DEFAULT_MAX_PAGES_PER_CHUNK));
    expect(r.chunks[0]).toMatchObject({ index: 0, pageStart: 1, pageEnd: 5, pageCount: 5 });
    expect(r.chunks[r.chunks.length - 1].pageEnd).toBe(12);
    // Each chunk is a real openable PDF with the right page count.
    for (const c of r.chunks) {
      const probe = await probePdfPageCount(c.buffer);
      expect(probe).toBe(c.pageCount);
    }
  });

  it("respects a custom maxPagesPerChunk", async () => {
    const bytes = await makePdf(10);
    const r = await chunkPdf(bytes, { maxPagesPerChunk: 3 });
    expect(r.chunks.map((c) => c.pageCount)).toEqual([3, 3, 3, 1]);
  });

  it("materialises only the keepPages list when provided", async () => {
    const bytes = await makePdf(20);
    // TOC profiler decided pages 3, 4, 11, 12 are the line-item pages.
    const r = await chunkPdf(bytes, { keepPages: [3, 4, 11, 12], maxPagesPerChunk: 2 });
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[0].pageCount).toBe(2);
    expect(r.chunks[1].pageCount).toBe(2);
    expect(await probePdfPageCount(r.chunks[0].buffer)).toBe(2);
    expect(await probePdfPageCount(r.chunks[1].buffer)).toBe(2);
  });

  it("returns one chunk for a single-page PDF regardless of cap", async () => {
    const bytes = await makePdf(1);
    const r = await chunkPdf(bytes, { maxPagesPerChunk: 10 });
    expect(r.chunks.length).toBe(1);
    expect(r.chunks[0].pageCount).toBe(1);
  });

  it("throws PDF_TOO_LARGE when over the sync ceiling", async () => {
    const bytes = await makePdf(SYNC_MAX_TOTAL_PAGES + 1);
    let caught = null;
    try {
      await chunkPdf(bytes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("PDF_TOO_LARGE");
    expect(caught.totalPages).toBe(SYNC_MAX_TOTAL_PAGES + 1);
  });

  it("accepts a higher maxTotalPages for background-mode callers", async () => {
    const bytes = await makePdf(SYNC_MAX_TOTAL_PAGES + 5);
    const r = await chunkPdf(bytes, { maxTotalPages: SYNC_MAX_TOTAL_PAGES + 10 });
    expect(r.totalPages).toBe(SYNC_MAX_TOTAL_PAGES + 5);
    expect(r.chunks.length).toBeGreaterThan(0);
  });

  it("populates duration_ms + size diagnostics", async () => {
    const bytes = await makePdf(4);
    const r = await chunkPdf(bytes);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.source_size_bytes).toBe(bytes.byteLength);
    expect(r.result_size_bytes).toBeGreaterThan(0);
  });
});
