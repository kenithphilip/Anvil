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

## Phase 2 — the last-resort escalation, dark-flagged (SHIPPED in this PR)

`src/api/_lib/docai/density-chunk.js` — `densityChunkedExtract` (a sibling of
`chunkedExtract`), wired into `run.js` after the #525 escalation, behind
`tenant_settings.docai_density_chunk_enabled` (**migration 223**, default false).

It:
- calls `planRowWindows(bodyText)`; if `!tableFound` or `itemCount < min`, returns
  a signal to fall back to single-shot;
- runs each window through `dispatchExtract` in **text mode**
  (`hints.bodyText = buildWindowBodyText(plan, window)`), at the generation tier;
- **merges** via the existing `mergeChunkResults`, which concatenates lines in
  window order, takes the customer/head fields (incl. `quote_number` and
  `stated_line_count`) from the first window that has them, and returns the
  nested `normalized` shape `run.js` reads. No dedup pass is needed **or
  present** — row windows *partition* the item blocks, so the same item cannot
  appear twice. (That is a requirement of this merge, not an accident: there is
  no line-level dedup anywhere downstream, contrary to a stale comment that this
  PR corrects.) Per-window failures contribute an empty line array and are
  reported, never silently dropped.

Trigger in `run.js`: the flag is on, the kind is po/rfq/quote, the previous
attempt is **still deficient** (`output_truncated`, or `ok` with zero lines),
there is a text layer, the deadline has not passed, and `shouldRowChunk` fires —
i.e. only genuinely too-big tables reach it. Bounded by the same `runCost` cap
and run deadline (both re-checked **per window**), and the density result is
**adopted only when it recovers more lines** than the attempt before it, so a
worse or empty result can never replace a better one.

## Phase 3a — the proactive trigger (SHIPPED)

Phase 2 reaches the row windows only as a *third* pass: cheap single-shot →
generation-tier retry → density. On a document already known to be too dense,
the first two are **doomed by construction**, and on a tight run budget they can
exhaust it before the density step is ever reached.

So `run.js` now checks **before** the first dispatch: flag on, density kind,
a text layer, deadline not passed, and `shouldRowChunk(bodyText)` → go straight
to `densityChunkedExtract`. One pass of N windows instead of three passes.

- **Falls through** to the normal path on any `{skip}` signal or a result with
  no lines, so a mis-read of density costs a fallback, never an extraction.

### Three rules the proactive path must obey (from adversarial review)

Going first means owning the failure, and an adopted density result reports
`model_selection_reason: "escalate_quality"` — which is **not** in
`CHEAP_TIER_REASONS`, so neither escalation can fire afterwards, and
`densityAttempted` blocks the reactive path. Everything downstream of adoption
is therefore *structurally unable to recover*. Hence:

1. **Adopt only a COMPLETE run.** `merged.ok` is `okAny` — one good window out
   of six — so `density_complete` (every planned window ran **and** succeeded,
   no budget breach, no deadline cut) is what the proactive path requires.
   Adopting a partial would ship part of a line table as a green run with every
   recovery mechanism disabled behind it.
2. **Reserve budget for the fallback.** Windows run sequentially at the
   generation tier; without a reserve a slow/failing proactive pass leaves the
   fallback with the deadline already behind it, so every adapter records
   `skipped_deadline` and the run fails outright — strictly worse than the cheap
   pass it replaced. `DOCAI_DENSITY_RESERVE_MS` (default 15s) is held back.
3. **A higher bar than reactive.** Reactive only spends extra calls after a real
   failure; proactive spends them up front on a document that might have been
   fine. `DOCAI_DENSITY_PROACTIVE_MIN_ITEMS` (default 60) vs the reactive 46.

`density-chunk.js` also **strips `source.bytes`/`url`** per window: only the LLM
adapters honour `hints.bodyText`, while docling / marker / unstructured /
azure_di / reducto read the bytes and would extract the **whole document for
every window** — and the dispatcher does not stop at the first success below the
fallback-confidence threshold, so one of them can win a window and contribute a
full-document line set N times over into a merge that has no dedup. Without
bytes they report `no_source_bytes` and are skipped, which is correct: a row
window is a text artifact.
- **`densityAttempted`** guards the Phase 2 reactive block: if the proactive
  pass already tried row windows on this same text and did not help, running the
  identical plan again is guaranteed waste.
- `isDensityKind` / `DENSITY_KINDS` are exported from `density-chunk.js` and
  used by BOTH call sites, so the proactive and reactive triggers cannot drift.

Covered by integration tests through `runExtractionPipeline` (dense text →
every dispatch is a window with `escalate:true` + a `density_window` index and
the full document is never sent; flag off → unchanged single-shot; sparse doc →
unchanged single-shot).

## Phase 3b — the background path (SHIPPED)

Past a handful of windows a document must move to the background worker, because
the sync run has a deadline. Two things were needed, and the second is the one
that actually mattered.

### It needed NO new storage
The worker persists **no chunk bytes at all** — it re-materialises them every
tick, by design:

> *"Store chunk_status without the bytes; we re-materialise bytes on each tick
> rather than persisting them (they would bloat the row and we already have the
> source)."* — `cron/extraction_jobs.js`

`planRowWindows` is **pure over the same text layer**, so a row window is
re-derivable on exactly those terms: tick N rebuilds the identical window N.
So no window text is stored and **no migration** is needed — the mode rides on
the `chunk_status` jsonb entries the worker already iterates
(`{ index, mode: "row", item_count, status, attempts }`), and `loadBodyText`
re-derives the text layer per tick (deterministic, local, LLM-free: CPU, not
money).

- **Chunking stage** — plan row windows when the text is dense; otherwise fall
  back to `chunkPdf` exactly as before.
- **Extracting stage** — for a row chunk, re-derive the plan, take window `idx`,
  dispatch it as **text** with the bytes **stripped** (same reason as the sync
  path). If the plan no longer applies on re-derive, the chunk fails loudly
  rather than silently extracting the wrong rows.
- **Merging stage** — row windows have no page geometry, so they are weighted by
  **item count** (the merge weights confidence by `pageCount`; without this a
  25-item window would count the same as a 3-item one).

### The part that made it reachable: density-aware ELIGIBILITY
The background path was gated purely on **page count > 40**
(`BACKGROUND_PAGE_THRESHOLD`) — blind to the very document this feature exists
for. A 200-line contract on 4 pages is nowhere near 40 pages, so it would never
have reached the worker however well the worker handled it. `docai/extract.js`
now also routes by **window count**: `planDensityChunking().needsBackground`
(more windows than `SYNC_WINDOW_BUDGET`, default 6) sets `large_pdf` plus a new
`dense_background` flag. The division of labour:

| windows | path |
|---|---|
| ≤ 6 | **sync** — Phase 3a proactive density, in-process |
| > 6 | **background** — one window per cron tick, no deadline ceiling |

`density-plan.js` holds that single decision so the sync path, the eligibility
check and the worker cannot disagree about what "row-chunkable" means.

## Phase 3c — not built, and why

- **Overlap-reconcile.** Windows currently partition the item blocks exactly,
  which is what lets the merge skip dedup entirely. Overlapping windows by one
  item to self-heal a mis-cut boundary would require a real dedup pass in
  `mergeChunkResults` (there is none downstream today). Only worth it if a real
  document is observed being mis-cut.

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
