// L2 OCR layer.
//
// Phase B of EXTRACTION_PIPELINE_PLAN.md. When L1 (text_layer.js)
// reports `image_only` or `extract_failed`, the dispatcher calls
// this module to run OCR. The output is stored in
// extraction_ocr_layer (cache) and fed back to the LLM dispatcher
// as `hints.bodyText`, the same hint claude.js already routes to
// `pre_extracted_text` mode.
//
// This eliminates the `image_pdf_no_text` failure mode at its
// source: a scanned PO that has zero text layer flows
//
//   L1 -> "image_only"
//   L2 -> Mistral OCR -> body text + per-block bboxes
//   L4 -> Claude with hints.bodyText (no PDF round-trip, no
//         binary noise, no "model returned classification=non_po
//         after burning credits" failure mode).
//
// The OCR result is cached by document_id (or content_hash for
// inline-attachment runs). Subsequent extraction runs for the same
// document reuse the cached text + bbox metadata, saving the
// Mistral call.

import { ocrDocument } from "../mistral.js";

const PER_PAGE_TEXT_THRESHOLD = 30;
const MAX_BODY_TEXT_BYTES = 200_000;

const trimBodyText = (s) => {
  if (!s) return null;
  if (Buffer.byteLength(s, "utf8") <= MAX_BODY_TEXT_BYTES) return s;
  return s.slice(0, MAX_BODY_TEXT_BYTES);
};

// Convert Mistral's normalized per-page blocks into a single text
// blob (page-separated) plus a per-page breakdown. We sort blocks
// top-to-bottom + left-to-right by their bbox so the model sees
// reading-order text rather than the OCR provider's internal
// emission order. Blocks without bboxes fall back to insertion
// order.
const blocksToText = (blocks) => {
  const sorted = [...(blocks || [])].sort((a, b) => {
    const ay = a?.bbox ? Number(a.bbox[1] || 0) : 0;
    const by = b?.bbox ? Number(b.bbox[1] || 0) : 0;
    if (Math.abs(ay - by) > 6) return ay - by;
    const ax = a?.bbox ? Number(a.bbox[0] || 0) : 0;
    const bx = b?.bbox ? Number(b.bbox[0] || 0) : 0;
    return ax - bx;
  });
  return sorted
    .map((b) => (b?.text || "").trim())
    .filter((s) => s.length >= 1)
    .join("\n");
};

const summarisePages = (pages) => {
  if (!Array.isArray(pages)) return [];
  return pages.map((p) => {
    const text = blocksToText(p.blocks);
    return {
      page: Number(p.index ?? 0) + 1,
      blocks: (p.blocks || []).length,
      chars: text.length,
      has_text: text.length >= PER_PAGE_TEXT_THRESHOLD,
    };
  });
};

const classifyOcr = (totalChars, pageBreakdown) => {
  if (totalChars < PER_PAGE_TEXT_THRESHOLD) return "failed";
  const allHaveText = pageBreakdown.every((p) => p.has_text);
  return allHaveText ? "ok" : "partial";
};

// Public API. Pass raw bytes (PDF or image). Returns the same
// shape text_layer.js does so the dispatcher can treat L1 + L2
// uniformly:
//
//   {
//     ok, status: 'ok' | 'partial' | 'failed',
//     page_count, char_count,
//     body_text: string | null,
//     page_breakdown: [{page, blocks, chars, has_text}],
//     bbox_count: number,
//     provider: 'mistral',
//     provider_model: 'mistral-ocr-latest' | ...,
//     latency_ms,
//     raw_pages: [{ index, blocks: [{text, bbox, confidence}] }],
//     error
//   }
//
// raw_pages is kept on the in-memory return only; the cache row
// stores the compact summary.
export const extractOcrLayer = async ({ buffer, filename, mimeType, opts }) => {
  const t0 = Date.now();
  if (!buffer || !buffer.length) {
    return {
      ok: false,
      status: "failed",
      page_count: 0,
      char_count: 0,
      body_text: null,
      page_breakdown: [],
      bbox_count: 0,
      provider: "mistral",
      provider_model: null,
      latency_ms: Date.now() - t0,
      raw_pages: [],
      error: "no bytes provided",
    };
  }
  let result;
  try {
    result = await ocrDocument({ buffer, filename, mimeType, opts });
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      page_count: 0,
      char_count: 0,
      body_text: null,
      page_breakdown: [],
      bbox_count: 0,
      provider: "mistral",
      provider_model: null,
      latency_ms: Date.now() - t0,
      raw_pages: [],
      error: err?.message || "ocr_threw",
    };
  }
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  const breakdown = summarisePages(pages);
  const merged = pages.map((p) => blocksToText(p.blocks)).join("\n\n").trim();
  const charCount = merged.length;
  const status = classifyOcr(charCount, breakdown);
  const bboxCount = pages.reduce(
    (acc, p) => acc + (p.blocks || []).filter((b) => b?.bbox).length,
    0,
  );
  return {
    ok: status !== "failed",
    status,
    page_count: pages.length,
    char_count: charCount,
    body_text: status === "failed" ? null : trimBodyText(merged),
    page_breakdown: breakdown,
    bbox_count: bboxCount,
    provider: "mistral",
    provider_model: result?.model || null,
    latency_ms: Date.now() - t0,
    raw_pages: pages,
    error: null,
  };
};

// Exported for tests + future cross-module use.
export const __test__ = { blocksToText, summarisePages, classifyOcr };
export const OCR_LAYER_THRESHOLDS = {
  perPage: PER_PAGE_TEXT_THRESHOLD,
  bodyTextBytes: MAX_BODY_TEXT_BYTES,
};
