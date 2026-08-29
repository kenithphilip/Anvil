// Density-aware extraction: split a line-dense text layer into row windows and
// extract each, when a page-few document is too dense for one call (Phase 2).
//
// The last resort after the generation-tier retry (#525) still truncates or
// returns empty on a page-few-but-line-dense doc: pdf-chunker splits by PAGE and
// cannot help, so we split the TEXT by row windows (text-row-chunker.js) and run
// each window through the text-mode extractor, then merge the line arrays with
// the same merger the page chunker uses (mergeChunkResults handles the nested
// `normalized` shape run.js reads).
//
// Gated by tenant_settings.docai_density_chunk_enabled (default off). Bounded by
// the shared runCost cap and the run deadline: each window is one call.

import { dispatchExtract } from "./index.js";
import { mergeChunkResults } from "./chunked-extract.js";
import { planRowWindows, shouldRowChunk, buildWindowBodyText } from "./text-row-chunker.js";

const emit = (sink, e) => { if (typeof sink === "function") { try { sink(e); } catch (_e) { /* never throw out of progress */ } } };

// Returns a merged extraction result (same shape as dispatchExtract) OR a
// { skip: true, reason } signal telling the caller to keep its existing result.
export const densityChunkedExtract = async (args) => {
  const { source, settings, customerId, hints = {}, runCost = null } = args;
  const opts = args.opts || {};
  const eventSink = opts.eventSink || null;
  const deadlineAt = opts.deadlineAt || null;

  const bodyText = hints.bodyText;
  if (!bodyText || typeof bodyText !== "string") {
    return { skip: true, reason: "no_body_text" };
  }
  if (!shouldRowChunk(bodyText, { minItems: opts.minItems })) {
    return { skip: true, reason: "not_dense_enough" };
  }

  const plan = planRowWindows(bodyText, { maxItemsPerWindow: opts.maxItemsPerWindow });
  // A single window is just the single-shot call again — nothing to gain.
  if (!plan.tableFound || plan.windows.length < 2) {
    return { skip: true, reason: plan.tableFound ? "single_window" : "no_table" };
  }

  emit(eventSink, { stage: "density_chunking_started", item_count: plan.itemCount, window_count: plan.windows.length });

  const windowResults = [];
  const pseudoChunks = [];
  let budgetBreachedAt = null;
  let deadlineHitAt = null;
  for (const w of plan.windows) {
    if (runCost && runCost.hasExceeded()) { budgetBreachedAt = w.index; break; }
    if (deadlineAt && Date.now() >= deadlineAt) { deadlineHitAt = w.index; break; }
    const windowBody = buildWindowBodyText(plan, w);
    emit(eventSink, { stage: "density_window_started", window_index: w.index, window_count: plan.windows.length, item_count: w.itemCount });
    const t0 = Date.now();
    let out;
    try {
      out = await dispatchExtract({
        source,
        settings,
        customerId,
        // escalate:true -> generation tier; a 25-item window fits its budget
        // with huge margin, so a window never re-truncates.
        hints: { ...hints, bodyText: windowBody, escalate: true, density_window: w.index },
        runCost,
      });
    } catch (e) {
      out = { ok: false, reason: "density_window_threw", error: e?.message || String(e), normalized: { classification: null, customer: null, lines: [] }, confidences: {}, attempts: [] };
    }
    windowResults.push(out);
    // Weight the merge by item count so confidence reflects window size.
    pseudoChunks.push({ index: w.index, pageCount: Math.max(1, w.itemCount) });
    emit(eventSink, { stage: "density_window_done", window_index: w.index, ok: !!out.ok, duration_ms: Date.now() - t0, lines: (out?.normalized?.lines || []).length });
  }

  if (!windowResults.length) {
    return { skip: true, reason: budgetBreachedAt != null ? "over_run_budget" : "no_windows_run" };
  }

  const merged = mergeChunkResults(windowResults, pseudoChunks);
  merged.density_chunked = true;
  merged.density_window_count = plan.windows.length;
  merged.density_windows_run = windowResults.length;
  if (budgetBreachedAt != null) { merged.over_run_budget = true; merged.budget_breached_at_window = budgetBreachedAt; }
  if (deadlineHitAt != null) { merged.deadline_hit_at_window = deadlineHitAt; }
  emit(eventSink, {
    stage: "density_chunking_done",
    window_count: plan.windows.length,
    windows_run: windowResults.length,
    line_count: (merged.normalized?.lines || []).length,
    ok: !!merged.ok,
  });
  return merged;
};
