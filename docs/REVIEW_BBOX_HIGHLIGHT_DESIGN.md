# Review screen: hover-a-field → highlight it on the PDF (PARKED backlog)

Status: **Parked design.** Goal: on the order Review/reconciliation screen,
hovering an extracted field highlights the matching region on the source
PDF/image with a bounding box (and vice-versa). Findings from a verified audit
(file:line accurate as of 2026-07).

## It's ~70% already built
| Piece | Status | Where |
|---|---|---|
| PDF preview with SVG bbox overlay, hover/click-wired | ✅ built | `src/v3-app/components/PdfPagePreview.tsx` (react-pdf canvas + `<rect>` per evidence row, `ReviewPaneSelection`) |
| Image preview overlay | ✅ built | `BboxOverlay.tsx` (used on the Documents screen) |
| Mounted on the order Review tab | ✅ | `so-workspace.tsx` → `ReviewPane.tsx` → `DocumentPreview` |
| Evidence store (page + bbox) | ✅ | `evidence` table (`001_init.sql`: field_path, page_number, bbox jsonb); `POST /api/documents/ocr` writes it; `GET /api/documents/[id]/evidence` reads it |
| Bidirectional selection context | ✅ | `ReviewPaneContext.tsx` (hoveredField/selectedField) |

The image path on the Documents screen **already hover-highlights** end-to-end,
which proves the render/selection stack works. So this is **data plumbing, not
new UI.**

## Why it's dark on the order Review screen
1. **Two disjoint field_path namespaces never join.** Overlay rects are keyed by OCR block path `ocr.page[N].block[M]` (`evidence.field_path`, set in `documents/ocr.js`), while the right-pane field rows + selection context are keyed by SEMANTIC paths (`customer.gstin`, `lines[3].partNumber`) from `orders.evidence_by_field`. `isActive` in `PdfPagePreview.tsx:214` compares across the two namespaces → never matches.
2. **No coordinates exist for a natively-read PDF.** When Claude reads a text/image PDF natively, the pipeline skips OCR (`run.js:490` gate), and `stampEvidenceOnLines` (`run.js:931`) is guarded off — so no bboxes are produced. The auto-pipeline also only stores OCR **counts** (`bbox_count`), not coordinates (they stay in-memory). That's why PAGE·LINE shows "—" and no boxes draw.

## What to build (data plumbing)
1. **Produce a coordinate layer for every document:**
   - **Text PDFs →** enable PDF.js `getTextContent()` word boxes (pdf.js already bundled; text layer is just off at `PdfPagePreview.tsx:190`). Exact coords, **free, no OCR**.
   - **Image-only PDFs →** reuse the existing **Mistral OCR → `evidence` table** pass (block-level, ~$2/1k pages) — render path already done. (Tesseract.js is an option for word-level client-side boxes but is greenfield + CSP-bound to self-hosted WASM; not needed.)
2. **Reconcile semantic fields ↔ coordinates:** extend the existing token-overlap matcher `_lib/docai/bbox-evidence.js findEvidenceForLine` from line items to header fields, and write the result either as a semantic `field_path` on `evidence` rows OR as `bbox`+`page` on `evidence_by_field` entries. `stampEvidenceOnLines` already produces per-line `{page,bbox}` — it's just stranded on `extraction_runs.normalized_extract`; surface it.
3. **Return matching rows:** have `/api/documents/[id]/evidence` (or the order payload) return rows whose `field_path` matches `evidence_by_field` keys so `isActive` finally matches. No changes to the overlay/selection components.

This also fixes the PAGE·LINE "—" symptom (same root cause: no coordinate attribution).

## Stale comments to fix while here
- `bbox-evidence.js:11-12` wrongly says `extraction_ocr_layer` persists `page_breakdown[].blocks[].bbox` — it persists **counts**.
- migration `091:37` "full bboxes still go to evidence/ocr_runs" is true only for the manual `/api/documents/ocr` path, not the auto-pipeline.

Key files: `PdfPagePreview.tsx`, `BboxOverlay.tsx`, `ReviewPane.tsx`, `ReviewPaneContext.tsx`; `documents/ocr.js`, `documents/[id]/evidence.js`; `_lib/docai/run.js` (:490 OCR gate, :931 stamp), `ocr_layer.js`, `bbox-evidence.js`, `text_layer.js`; `001_init.sql` (:151 evidence_by_field, :210 evidence).
