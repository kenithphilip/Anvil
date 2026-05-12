// PDF page chunker. Splits a multi-page PDF into smaller PDF
// buffers so the extraction pipeline can process them
// chunk-by-chunk and stay inside the Vercel 60-second function
// ceiling + the model's input-token budget. Each chunk is a
// real, openable PDF; downstream adapters need no special
// handling.
//
// Why this exists. A 70-page customer PO at ~1.5s/page through
// Claude Sonnet does not finish in one HTTP request. Even when
// it does, the input-token cost grows linearly with page count
// while only the first 5-10 pages of a typical industrial PO
// carry line items: the rest is T&C boilerplate. The TOC
// profiler (separate module) decides which pages to keep; the
// chunker then materialises the kept pages into ~N-page sub-PDFs
// the extractor can consume one at a time.
//
// Chunk sizing. Default 5 pages per chunk is the empirically
// sweet spot for Claude Sonnet (fits comfortably in cache, runs
// in ~6-8s, leaves headroom for retries inside the 60s budget).
// Callers can tune via opts.maxPagesPerChunk for cheaper models.
// A chunk never contains zero pages; if the input has only one
// page the result is one chunk regardless of cap.
//
// The chunker is OFF the synchronous extraction path until
// run.js opts in via a `chunk: true` hint. Existing single-page
// or short multi-page POs keep their fast non-chunked path.

import { PDFDocument } from "pdf-lib";

// Hard ceilings. Above MAX_PAGES we refuse to chunk and bubble
// up an explicit error so the operator gets a clear message
// instead of a silent OOM. The background-job worker (Phase C)
// raises this ceiling because it can run across multiple cron
// ticks.
export const DEFAULT_MAX_PAGES_PER_CHUNK = 5;
export const SYNC_MAX_TOTAL_PAGES = 60;
export const BACKGROUND_MAX_TOTAL_PAGES = 500;

// Output shape, documented inline (this is a .js file; the
// TypeScript consumer infers via JSDoc when it imports).
//
// chunkPdf() returns:
//   {
//     totalPages: number,
//     chunks: Array<{
//       index: number,            // zero-based chunk number
//       pageStart: number,        // one-based inclusive
//       pageEnd: number,          // one-based inclusive
//       pageCount: number,        // pageEnd - pageStart + 1
//       buffer: Uint8Array,       // re-serialised PDF, kept pages only
//     }>,
//     source_size_bytes: number,
//     result_size_bytes: number,
//     duration_ms: number,
//   }

const toUint8 = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input && typeof input === "object" && "buffer" in input) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  if (typeof input === "string") {
    // base64 -> bytes. The adapters keep PDFs as base64 strings
    // for transport, so the chunker accepts either form.
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error("chunkPdf: input must be Uint8Array, Buffer, or base64 string");
};

// Return total page count for an input PDF without materialising
// any chunks. Cheap probe used by the dispatcher to decide
// whether the chunked path is even needed.
export const probePdfPageCount = async (input) => {
  const bytes = toUint8(input);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
};

// Validate the page-keep list. Pages outside [1, totalPages]
// are dropped silently; duplicates are deduped. Returns a
// monotonically increasing array of 1-based page numbers.
const normaliseKeep = (totalPages, keep) => {
  if (!Array.isArray(keep) || !keep.length) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const seen = new Set();
  const out = [];
  for (const p of keep) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
};

// Group a sorted page list into chunks of at most maxPerChunk
// each. Groups are contiguous in the keep list (not necessarily
// contiguous page numbers): e.g. keep=[1,2,5,6] with max=2 gives
// [[1,2],[5,6]]. The resulting PDFs each carry the kept pages
// in order.
const groupIntoChunks = (keep, maxPerChunk) => {
  const groups = [];
  for (let i = 0; i < keep.length; i += maxPerChunk) {
    groups.push(keep.slice(i, i + maxPerChunk));
  }
  return groups;
};

// Materialise one chunk by copying the listed pages from the
// source PDF into a fresh PDFDocument and serialising. Pages are
// inserted in the order requested so an extractor reading
// top-to-bottom sees them in the original sequence.
const materialiseChunk = async (srcDoc, pageNumbers, index) => {
  const out = await PDFDocument.create();
  const zeroBased = pageNumbers.map((n) => n - 1);
  const copied = await out.copyPages(srcDoc, zeroBased);
  for (const p of copied) out.addPage(p);
  const buffer = await out.save({ useObjectStreams: true });
  return {
    index,
    pageStart: pageNumbers[0],
    pageEnd: pageNumbers[pageNumbers.length - 1],
    pageCount: pageNumbers.length,
    buffer,
  };
};

// Public entry point. Splits the input PDF into chunks the
// extractor can run one at a time.
//
// opts:
//   maxPagesPerChunk  number, default 5
//   keepPages         optional list of 1-based page numbers to
//                     retain. When set the TOC profiler upstream
//                     has already decided which pages carry the
//                     line items; we materialise only those.
//   maxTotalPages     hard ceiling. Defaults to SYNC_MAX_TOTAL_PAGES;
//                     pass BACKGROUND_MAX_TOTAL_PAGES from the job
//                     worker.
export const chunkPdf = async (input, opts = {}) => {
  const t0 = Date.now();
  const bytes = toUint8(input);
  const maxPerChunk = Math.max(1, Number(opts.maxPagesPerChunk || DEFAULT_MAX_PAGES_PER_CHUNK));
  const maxTotal = Math.max(1, Number(opts.maxTotalPages || SYNC_MAX_TOTAL_PAGES));

  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();
  if (totalPages > maxTotal) {
    const err = new Error(
      "chunkPdf: PDF has " + totalPages + " pages, exceeds max " + maxTotal
      + " (use background-job mode for documents this large)"
    );
    err.code = "PDF_TOO_LARGE";
    err.totalPages = totalPages;
    err.maxAllowed = maxTotal;
    throw err;
  }

  const keep = normaliseKeep(totalPages, opts.keepPages);
  if (!keep.length) {
    return { totalPages, chunks: [], source_size_bytes: bytes.byteLength, result_size_bytes: 0, duration_ms: Date.now() - t0 };
  }

  const groups = groupIntoChunks(keep, maxPerChunk);
  const chunks = [];
  let resultBytes = 0;
  for (let i = 0; i < groups.length; i++) {
    const chunk = await materialiseChunk(srcDoc, groups[i], i);
    chunks.push(chunk);
    resultBytes += chunk.buffer.byteLength;
  }

  return {
    totalPages,
    chunks,
    source_size_bytes: bytes.byteLength,
    result_size_bytes: resultBytes,
    duration_ms: Date.now() - t0,
  };
};

// Test seam: expose the pure helpers so a unit test can drive
// the grouping logic without a live PDF.
export const __test = { normaliseKeep, groupIntoChunks };
