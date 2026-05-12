// Bbox-anchored evidence review (Wave 4.3 / #11).
//
// The Mistral OCR layer (and Azure DI, when configured) returns
// per-block bounding boxes alongside text. The dispatcher's
// confidence drops on a line and the operator wonders WHERE on
// the document the model read that value. With bboxes anchored,
// the workspace can render a click-to-highlight overlay on the
// document preview: tap a line in the recon table, the
// corresponding bbox glows on the PDF/image preview.
//
// Today the OCR layer persists bboxes on extraction_ocr_layer
// (page_breakdown[].blocks[].bbox) but the LLM stage doesn't
// thread them through to normalized.lines. This module
// post-processes a successful extraction and decorates each
// extracted line with the best-matching bbox by:
//
//   1. Collecting every OCR block on every page with its bbox.
//   2. For each extracted line, computing the best-fit page +
//      bbox by overlapping the line's part_number / description
//      / unit_price tokens against the per-block text.
//   3. Stamping line._evidence = { page, bbox: [x0,y0,x1,y1],
//      bbox_norm: [...], score, token_overlap } so the UI can
//      render the highlight.
//
// Output evidence is best-effort: when no match crosses the
// threshold the line gets no _evidence and the UI shows no
// overlay. We never invent bboxes.

const MIN_MATCH_TOKEN_OVERLAP = 1;
const STOP_TOKENS = new Set([
  "the", "and", "for", "to", "in", "of", "by", "no", "nos",
  "each", "pcs", "set", "unit", "item",
]);

const significantTokens = (s) => {
  if (!s || typeof s !== "string") return [];
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
};

// Build a flat block list { page, blockIndex, text, bbox } from
// the OCR layer's page_breakdown shape (which carries page-level
// blocks). The dispatcher already keeps this on the in-memory
// ocrLayer object; raw_pages carries the per-block bbox.
export const buildBlockIndex = (ocrLayer) => {
  const blocks = [];
  if (!ocrLayer) return blocks;
  const pages = Array.isArray(ocrLayer.raw_pages) ? ocrLayer.raw_pages : [];
  pages.forEach((p, pIdx) => {
    const pageNum = Number.isFinite(p?.index) ? Number(p.index) + 1 : pIdx + 1;
    const blockArr = Array.isArray(p?.blocks) ? p.blocks : [];
    blockArr.forEach((b, bIdx) => {
      if (!b?.bbox || !b?.text) return;
      blocks.push({
        page: pageNum,
        blockIndex: bIdx,
        text: String(b.text),
        bbox: b.bbox.slice ? b.bbox.slice(0, 4) : b.bbox,
        bbox_norm: b.bbox_norm || null,
        confidence: Number(b.confidence) || null,
      });
    });
  });
  return blocks;
};

// Score how well a line matches a block: count the number of
// line's significant tokens that appear in the block's text.
// Tiebreak by block confidence.
const scoreLineBlock = (lineTokens, block) => {
  if (!lineTokens.length || !block?.text) return { overlap: 0, conf: 0 };
  const blockTokens = new Set(significantTokens(block.text));
  let overlap = 0;
  for (const t of lineTokens) if (blockTokens.has(t)) overlap++;
  return { overlap, conf: Number(block.confidence) || 0 };
};

// Find the best block for one line; returns the evidence object
// or null when no block crosses the threshold.
export const findEvidenceForLine = (line, blockIndex) => {
  if (!line || !blockIndex?.length) return null;
  const lineText = [line.partNumber, line.itemCode, line.description, line.customer_part_number].filter(Boolean).join(" ");
  const tokens = significantTokens(lineText);
  if (!tokens.length) return null;
  let best = null;
  for (const b of blockIndex) {
    const s = scoreLineBlock(tokens, b);
    if (s.overlap < MIN_MATCH_TOKEN_OVERLAP) continue;
    if (!best || s.overlap > best.overlap || (s.overlap === best.overlap && s.conf > best.conf)) {
      best = { ...b, overlap: s.overlap, conf: s.conf };
    }
  }
  if (!best) return null;
  return {
    page: best.page,
    bbox: best.bbox,
    bbox_norm: best.bbox_norm,
    score: best.overlap,
    confidence: best.conf,
  };
};

// Public: walk every line and stamp _evidence in place. Returns
// the count of lines that got evidence stamped. Pure mutation;
// safe to call on the normalized object that's about to be
// persisted on extraction_runs.normalized_extract.
export const stampEvidenceOnLines = (normalized, ocrLayer) => {
  if (!normalized?.lines || !ocrLayer) return 0;
  const blocks = buildBlockIndex(ocrLayer);
  if (!blocks.length) return 0;
  let stamped = 0;
  for (const line of normalized.lines) {
    const ev = findEvidenceForLine(line, blocks);
    if (ev) {
      line._evidence = ev;
      stamped++;
    }
  }
  return stamped;
};

export const __test = { significantTokens, scoreLineBlock };
