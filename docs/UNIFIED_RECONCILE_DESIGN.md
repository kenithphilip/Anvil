# Unified PO Review + Line Reconciliation

Status: building (branch `feat/unified-po-reconcile`).
Author: operator-UX pass, 2026-07.

## Problem

In the SO Workspace (`#/so?id=<id>`) the operator reviews an extracted PO
across **two mutually-exclusive tabs**:

- **Review** (`ReviewPane`) — the PO **PDF** (PDF.js + bbox overlays) beside the
  extracted header/field list, with per-field confirm/flag/correct.
- **Reconciliation** (default) — the **line grid**: editable cells, item_master
  matching, "Suggest mappings", provenance/confidence chips, save.

They are `{tab === "review"}` vs `{tab === "recon"}` conditional renders, so
switching **unmounts** the other. To answer "does this line match the PO?" the
operator flips Review -> Recon -> Review repeatedly, losing PDF scroll/zoom/page
and any in-progress edit each time. The PO and the lines are never on screen
together.

## What already exists (reused, not rebuilt)

- `PdfPagePreview` renders the PDF with per-page SVG bbox overlays, keyed by
  `field_path`, and highlights the rect whose `field_path === selectedField`
  (and vice-versa on click).
- `ReviewPaneContext` (`ReviewPaneSelectionProvider`) owns hovered/selected
  field + per-field verify state and the `submitCorrection` -> `/api/docai/correction`
  call. Bidirectional field<->bbox highlighting is already wired.
- The recon grid already edits lines and, on cell blur, fires
  `/api/docai/correction` (`recordFieldCorrection`) to feed the learning loop.

So unification is **composition**, not new machinery.

## Design

### 1. One split view under the Recon tab

Remove the separate **Review** tab. The Reconciliation tab becomes a split,
all inside **one** `ReviewPaneSelectionProvider`:

```
┌─ view toggle:  [PDF] [Split] [Lines] ───────────────────────────┐
│ ┌── PO PDF (ReviewDocPane) ──┐ ┌── right column ──────────────┐ │
│ │  PdfPagePreview            │ │  ▸ Header fields (collapsed)  │ │
│ │  + bbox overlays           │ │    ReviewFieldsPane           │ │
│ │  (header + synthetic line  │ │  ── Line reconciliation grid  │ │
│ │   evidence rects)          │ │    (unchanged; rows now       │ │
│ │                            │ │     selectable)               │ │
│ └────────────────────────────┘ └───────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- **View toggle** `PDF | Split | Lines`, persisted to `localStorage`
  (`anvil:recon-view`). Defaults to `split` on wide viewports, `lines` on
  narrow (< ~1100px) so small screens are not cramped.
- Left pane (`ReviewDocPane`, extracted from `ReviewPane`) stays **mounted**
  across the collapse toggle (hidden via layout, not unmounted) so PDF scroll /
  zoom / page survive.
- Right column: a **collapsible header-field verify strip**
  (`ReviewFieldsPane`, groups `customer / order / totals / seller` only — the
  `lines` group is owned by the grid) above the existing line grid.

### 2. Bidirectional line <-> PDF linking

- Header fields: already works (existing `evidence` rows carry `field_path`).
- **Lines**: the `evidence` table stores per-token OCR bboxes; line geometry
  instead lives on `normalized.lines[i]._evidence` (`{page, bbox[4], bbox_norm}`).
  We synthesize `EvidenceBbox` rows from each draft line's `_evidence`
  (`field_path = "lines[<i>]"`), preferring `bbox_norm` (0..1 ->
  `page_width/height = 1`), and merge them into the rows fed to `PdfPagePreview`.
  Clicking a grid row sets `selectedField = "lines[<i>]"` -> the synthetic rect
  highlights and the PDF scrolls to it.
- Best-effort: a line with no usable `_evidence` still selects (row highlight);
  the PDF simply paints no rect for it. No regression when OCR bboxes are absent.
- `PdfPagePreview` gains a small scroll-to-selected effect (scrolls the active
  rect / its page into view when `selectedField` changes).

### 3. Deep-link / refresh survival

`setTab` also writes `?tab=` into the hash (today it is local-only), so the
active tab survives refresh and is shareable. A `?tab=review` deep-link maps to
`recon` (the tab it was merged into).

## Human-in-the-loop correction fixes

Recon found the learning loop is half-dead and the actor id is wrong:

1. **Dead writer — close the loop.** `learned_corrections` (read by
   `customer-hints` to inject "previously corrected" examples into the **next**
   extraction's prompt) has **no production writer** — `recordCorrections()` is
   imported nowhere. `/api/docai/correction` now calls it (best-effort) on every
   saved correction, so an operator fix actually primes the next extraction.
   The `customer_field_overrides` promotion path is unchanged.
2. **Null-actor bug.** `correction.js` wrote `ctx.userId` (undefined per the
   repo-wide `ctx.user.id` gotcha) into `extraction_corrections.user_id` and
   `rlhf_feedback.user_id`. Fixed to `ctx.user?.id || ctx.userId`.
3. `diffNormalized`'s classifier is factored into an exported
   `classifyDiff(fieldPath, modelValue, operatorValue)` so a single-field
   correction produces the same `{diff_kind, severity}` as the batch differ.

Out of scope (deferred): applying a correction back onto the current run/order
header (line edits already persist via the recon save path), and wiring the
built-but-unconnected `selective-reextract.js` per-line re-extraction endpoint.

## Risk / blast radius

- All UI changes are inside the Recon tab of one screen; no API contract, DB, or
  RBAC change on the UI side. The `ReviewPane` public component keeps identical
  DOM (its 4 test files stay green); the two panes are additive exports.
- `correction.js`: additive best-effort write + an actor-id fix; the response
  shape is unchanged. `learned_corrections` upsert is idempotent on
  `(tenant_id, extraction_run_id, field_path)`.
- No migration.
