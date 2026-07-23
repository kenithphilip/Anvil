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
// GEOMETRY SOURCE (fixed 2026-07-23). This used to read OCR blocks only, and
// the overlay consequently never rendered, for two independent reasons:
//   1. OCR only runs when the L1 text layer FAILED (run.js's wantsOcr gate), so
//      an ordinary digital PO has no OCR layer and nothing was ever stamped.
//   2. bbox_norm was read but never COMPUTED anywhere, and the UI discards any
//      evidence without it — so even OCR'd documents highlighted nothing.
// Now the index is source-agnostic (OCR blocks OR text-layer boxes from
// extractTextBlocks) and normalises coordinates itself.
//
// This module post-processes a successful extraction and decorates each
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

// Normalise an absolute [x0,y0,x1,y1] box to 0..1 against the page size.
//
// This has to exist here because NOTHING upstream ever produced bbox_norm:
// mistral.js emits `bbox` + page width/height and never a normalised copy, so
// buildBlockIndex's old `b.bbox_norm || null` was null for every block. The UI
// requires normalised coords (so-workspace.tsx checks Array.isArray(bbox_norm)
// and bails otherwise), which is why the highlight overlay never rendered even
// on documents that DID go through OCR.
//
// Coordinates are top-left origin, matching both OCR output and CSS overlay
// positioning. A box already in 0..1 is passed through untouched.
export const normaliseBbox = (bbox, pageWidth, pageHeight) => {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const nums = bbox.slice(0, 4).map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [ax, ay, bx, by] = nums;
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  const w = Number(pageWidth), h = Number(pageHeight);
  // Already normalised (every coord within the unit square) — pass through, so
  // a provider that returns fractions isn't divided by the page size again.
  if (x1 <= 1 && y1 <= 1) return [x0, y0, x1, y1];
  if (!(w > 0) || !(h > 0)) return null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return [clamp(x0 / w), clamp(y0 / h), clamp(x1 / w), clamp(y1 / h)];
};

// Build a flat block list { page, blockIndex, text, bbox } from a layer's
// raw_pages shape: [{ index, width, height, blocks: [{ text, bbox }] }].
//
// Source-agnostic on purpose. The OCR layer supplies this, and so does the L1
// text layer via extractTextBlocks() — which matters because OCR only runs
// when the text layer FAILED, so on an ordinary digital PO there is no OCR
// layer at all and this was the reason no evidence was ever stamped.
export const buildBlockIndex = (layer) => {
  const blocks = [];
  if (!layer) return blocks;
  const pages = Array.isArray(layer.raw_pages) ? layer.raw_pages : [];
  pages.forEach((p, pIdx) => {
    const pageNum = Number.isFinite(p?.index) ? Number(p.index) + 1 : pIdx + 1;
    const blockArr = Array.isArray(p?.blocks) ? p.blocks : [];
    blockArr.forEach((b, bIdx) => {
      if (!b?.bbox || !b?.text) return;
      const bbox = b.bbox.slice ? b.bbox.slice(0, 4) : b.bbox;
      blocks.push({
        page: pageNum,
        blockIndex: bIdx,
        text: String(b.text),
        bbox,
        bbox_norm: b.bbox_norm || normaliseBbox(bbox, p?.width, p?.height),
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
export const stampEvidenceOnLines = (normalized, layer) => {
  if (!normalized?.lines || !layer) return 0;
  const blocks = buildBlockIndex(layer);
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
