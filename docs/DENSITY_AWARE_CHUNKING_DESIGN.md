# Density-aware chunking (line-dense, page-few documents)

Follow-on to the FIAT dense-quote fix (#525). That PR makes a choked quote retry
at the generation tier (16k output budget). This handles the case that retry
cannot: a table so dense that even 16k tokens can't hold it in one call.

## The problem

`pdf-chunker.js` splits a document by **page**, and `cross-page-tables.js`
replicates the column header across **page** boundaries. Both assume the lines
are spread across pages. They cannot help a document that is dense **within few
pages** — the FIAT ARC is **~78 line items on 4 pages**, and real rate contracts
run to 200+. Raising `CHUNK_PAGE_THRESHOLD` does nothing: the lines are not on
more pages, they are packed onto the same ones. So the doc is extracted
single-shot, and past the model's output ceiling the line tail is dropped
(`output_truncated`) or the model punts the whole table (empty `lines[]`).

## The approach: split the TEXT LAYER by row windows

The pipeline already exposes `hints.bodyText` (the L1/L2 text layer) and the
extractor already accepts a text block. So instead of splitting the PDF by
pages, split the **text** by **row windows**:

1. Find the table's **header block** and its **line-item rows**.
2. Group rows into **logical items** (an item may span several physical rows).
3. Emit **windows of ≤ N items**, each carrying the document **preamble**
   (customer / quote number / currency) **and** the **column header**.
4. Run each window's `bodyText` through the text-mode extractor; **concatenate**
   the line arrays; take the header/customer from the first window.

Replicating the preamble + header into every window is what makes a mid-table
window extractable — the exact failure (`headerless mid-table chunk → 0 lines`)
that made page-chunking unsafe and drove the threshold to 25.

## Phase 1 — the pure planner (SHIPPED in this PR, inert)

`src/api/_lib/docai/text-row-chunker.js` — no I/O, no model, entity-agnostic:

- `shouldRowChunk(text, {minItems})` — is the table dense enough to be worth the
  extra calls (default ≥ 46 items, matching the observed single-call ceiling).
- `planRowWindows(text, {maxItemsPerWindow})` → `{ tableFound, itemCount,
  preamble, header, windows: [{ index, itemCount, text }] }`. Windows split
  **only on item-row boundaries**, so a logical item is never cut in half.
- `buildWindowBodyText(plan, window)` — preamble + header + rows for one window.

Fully unit-tested (`api-text-row-chunker.test.js`): FIAT-like single-row dense
table (stacked header, numbering gaps, terms tail), multi-physical-row-per-item,
and the no-table / no-header / garbage edges. **Not wired into the pipeline yet**
— it can be merged safely and does nothing until Phase 2 calls it.

## Phase 2 — wire it as the last-resort escalation (dark-flagged)

Add `densityChunkedExtract({ bodyText, settings, ... })` (a sibling of
`chunkedExtract`) that:
- calls `planRowWindows(bodyText)`; if `!tableFound` or `itemCount < min`, returns
  a signal to fall back to single-shot;
- runs each window through `dispatchExtract` in **text mode**
  (`hints.bodyText = buildWindowBodyText(plan, window)`), at the generation tier;
- **merges**: concatenate lines in window order; header/customer from the first
  non-empty window; dedupe on (part_no|customer_part_number + qty) so an
  accidental overlap between windows can't double-count; per-window failures are
  reported, never silently dropped (an item missing from a denominator is how a
  count flatters itself).

Wire into `run.js` as the step **after** the #525 generation-tier retry still
returns truncated/empty AND `shouldRowChunk(bodyText)` — i.e. only the genuinely
too-big tables reach it, behind `tenant_settings.docai_density_chunk_enabled`
(default off) for a pilot. Bounded by the same `runCost` cap and run deadline;
each window is one call, so the cap governs total spend.

## Phase 3 — refinements (later)

- **Proactive** trigger: when `shouldRowChunk` fires on the first-pass text, go
  straight to row windows instead of paying for a doomed single-shot + retry.
- **Background path** for very large contracts (hundreds of items) so the sync
  15s function ceiling isn't the limit.
- **Overlap windows** by one item + reconcile, to self-heal a boundary the
  planner mis-cut on an unusual layout.

## Limitations (honest)

- Needs a **text layer**; for image-only PDFs the OCR layer supplies `bodyText`,
  so the same path works, at OCR fidelity.
- Item detection is **heuristic** (leading S.No column). Single-row quotes (the
  primary target) are clean; a multi-row layout whose S.No is not on the block's
  first physical line can mis-attach a block's leading rows to the previous
  window — acceptable for the target, noted for Phase 3 overlap-reconcile.
- Not a parser: it splits text for the model, it does not itself read columns.

## Verification
`npm run check` + `api-text-row-chunker.test.js` (13 tests) + migration audit.
Phase 1 is additive and inert; Phase 2/3 land behind the dark flag.
