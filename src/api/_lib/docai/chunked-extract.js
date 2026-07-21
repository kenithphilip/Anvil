// Chunked extraction orchestrator.
//
// Wraps dispatchExtract so a multi-page PDF runs as N successive
// adapter calls, one per chunk, instead of a single call that
// would either blow the LLM input-token budget or hit Vercel's
// 60-second function ceiling. Each chunk is a small PDF carved
// out by pdf-chunker.js; this module decides whether chunking
// applies, dispatches per chunk, merges the normalised results,
// and writes progress events to processing_events so the UI can
// poll for "page 4 of 12 done" feedback.
//
// Two opt-in modes:
//
//   - sync mode (this module): caller awaits the whole walk and
//     gets the merged result back. Used by /api/orders POST when
//     the document is small-medium (<= SYNC_MAX_TOTAL_PAGES).
//
//   - job mode (Phase C, separate module): the chunker chops the
//     PDF once, the background-job worker dispatches chunks one
//     at a time across multiple cron ticks. This module's chunk-
//     dispatch helper is the building block.
//
// Merge rules:
//   - classification: first chunk that classifies as `po` wins;
//     otherwise the most-common label across chunks.
//   - confidence_overall: weighted by chunk pageCount.
//   - customer: first non-null customer block. Tenant scrub
//     still runs downstream.
//   - lines: concatenated in chunk order. The TOC profiler
//     output is the authoritative page-keep list; line
//     deduplication is handled at the next layer (validators).
//   - adapter_used: most common across chunks; on a tie, the
//     first chunk's adapter wins.
//   - latency_ms: sum across chunks.
//   - attempts: concatenated.

import { chunkPdf, probePdfPageCount, DEFAULT_MAX_PAGES_PER_CHUNK, SYNC_MAX_TOTAL_PAGES } from "./pdf-chunker.js";
import { dispatchExtract } from "./index.js";
import { detectSpanningTables, planHeaderReplication } from "./cross-page-tables.js";

// Page threshold above which we engage the chunker. Documents at or below this
// run the SINGLE-SHOT path — the whole PDF in one LLM call — which is what lets
// a multi-page line-item table extract correctly (chunking splits the table so
// a mid-table chunk has no column header and returns 0 lines). Raised 6 -> 25
// so a common 13-21pp PO reads every page in one context; keep it in step with
// run.js PROFILER_PAGE_THRESHOLD. Only genuinely large docs chunk. Modern
// vision LLMs (Gemini native-PDF 1M ctx; Claude 200k) handle 25pp in one call
// well under the 60s ceiling. Env-overridable.
export const CHUNK_PAGE_THRESHOLD = Math.max(1, Number(process.env.DOCAI_CHUNK_PAGE_THRESHOLD) || 25);

// Emit a per-stage event to processing_events. Best-effort. The
// caller (run.js) owns the tenant + case context and passes it
// via opts.eventSink so this module doesn't need its own
// serviceClient. eventSink(event) shape:
//   { stage, chunk_index, chunk_count, page_start, page_end,
//     page_count, ok, error, duration_ms, detail }
const emit = (eventSink, event) => {
  if (typeof eventSink !== "function") return;
  try { eventSink(event); } catch (_e) { /* never throw out of progress reporting */ }
};

// Pull the source's PDF bytes if any. We accept the same source
// shape dispatchExtract does: { bytes, mime, filename, ... }.
const isPdfSource = (source) => {
  if (!source) return false;
  const mime = String(source.mime || source.contentType || "").toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("/pdf")) return true;
  if (typeof source.filename === "string" && /\.pdf$/i.test(source.filename)) return true;
  return false;
};

const toBytes = (source) => {
  if (!source) return null;
  const b = source.bytes;
  if (!b) return null;
  if (b instanceof Uint8Array) return b;
  if (typeof b === "string") {
    // base64
    const buf = Buffer.from(b, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (b && typeof b === "object" && "buffer" in b) {
    return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength || 0);
  }
  return null;
};

// Most-common picker. Used for adapter_used + classification.
const mostCommon = (xs) => {
  const counts = new Map();
  for (const x of xs) {
    if (!x) continue;
    counts.set(x, (counts.get(x) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
};

// Merge per-chunk dispatchExtract outputs into the single
// normalised shape the rest of run.js expects.
export const mergeChunkResults = (chunkResults, chunks) => {
  if (!chunkResults.length) {
    return { ok: false, reason: "no_chunks", error: "no_chunks", lines: [], customer: null, confidences: {}, attempts: [] };
  }
  if (chunkResults.length === 1) {
    return { ...chunkResults[0] };
  }
  const adapterUsed = mostCommon(chunkResults.map((r) => r.adapter_used));
  const latencyMs = chunkResults.reduce((s, r) => s + (r.latency_ms || 0), 0);
  const okAny = chunkResults.some((r) => r.ok);
  // Classification: prefer "po" if any chunk found one; else fall
  // back to the most-common label so a 70-page doc that's mostly
  // T&C does not get mis-classified as non_po by majority vote.
  const classifications = chunkResults.map((r) => r?.classification || null).filter(Boolean);
  const classification = classifications.includes("po") ? "po"
    : classifications.includes("rfq") ? "rfq"
      : mostCommon(classifications) || null;
  // Customer: first non-null. Tenant scrub still runs in run.js.
  const customer = chunkResults.find((r) => r && r.customer)?.customer || null;
  // Lines: concatenate in chunk order, tagging each with the
  // source chunk so a downstream debugger can see which page
  // range produced it.
  const lines = [];
  for (let i = 0; i < chunkResults.length; i++) {
    const r = chunkResults[i];
    const ch = chunks[i] || {};
    for (const line of (r.lines || [])) {
      lines.push({ ...line, _chunk_index: i, _chunk_page_start: ch.pageStart, _chunk_page_end: ch.pageEnd });
    }
  }
  // Confidence: weighted by chunk pageCount, dropped to overall
  // when chunks disagree wildly (the spread itself is a signal
  // the document is messy).
  const weights = chunks.map((c) => Math.max(1, c?.pageCount || 1));
  const weightedConfidence = (key) => {
    let sum = 0;
    let total = 0;
    for (let i = 0; i < chunkResults.length; i++) {
      const v = Number(chunkResults[i]?.confidences?.[key]);
      if (!Number.isFinite(v)) continue;
      sum += v * weights[i];
      total += weights[i];
    }
    return total > 0 ? sum / total : 0;
  };
  const confidences = {};
  const allKeys = new Set();
  for (const r of chunkResults) {
    for (const k of Object.keys(r.confidences || {})) allKeys.add(k);
  }
  for (const k of allKeys) confidences[k] = weightedConfidence(k);
  const confidenceOverall = Number(
    chunkResults.reduce((s, r, i) => s + (Number(r.confidence_overall) || 0) * weights[i], 0)
    / weights.reduce((s, w) => s + w, 0)
  ) || 0;
  // Attempts: concatenate so the audit trail captures every
  // adapter every chunk tried.
  const attempts = chunkResults.flatMap((r, i) =>
    (r.attempts || []).map((a) => ({ ...a, _chunk_index: i }))
  );
  // Carry model identity + failure diagnostics THROUGH the merge. Previously
  // these were dropped, so a multi-chunk run that failed collapsed to
  // status_reason='fail_unknown' with selected_model=null (rendered "unknown
  // failure / model —") — the exact black box hit on the 7-page P250432265 PO.
  // Now the merged result surfaces the real model + the underlying reason.
  const selectedModel = mostCommon(chunkResults.map((r) => r.selected_model).filter(Boolean))
    || chunkResults.find((r) => r.selected_model)?.selected_model || null;
  const modelSelectionReason = chunkResults.find((r) => r.model_selection_reason)?.model_selection_reason || null;
  // On total failure, surface a representative reason/error from the chunks
  // (most-common reason; first non-empty error) instead of silently null.
  const failedResults = chunkResults.filter((r) => !r.ok);
  const failReason = okAny ? null
    : (mostCommon(failedResults.map((r) => r.reason).filter(Boolean))
       || failedResults.find((r) => r.reason)?.reason || null);
  const failError = okAny ? null : (failedResults.find((r) => r.error)?.error || null);

  return {
    ok: okAny,
    adapter_used: adapterUsed,
    selected_model: selectedModel,
    model_selection_reason: modelSelectionReason,
    ...(failReason ? { reason: failReason } : {}),
    ...(failError ? { error: failError } : {}),
    latency_ms: latencyMs,
    classification,
    customer,
    lines,
    confidences,
    confidence_overall: confidenceOverall,
    attempts,
    chunked: true,
    chunk_count: chunks.length,
  };
};

// Public entry point. Equivalent to dispatchExtract but for
// large PDFs: probes page count, chunks if above threshold,
// dispatches per chunk, merges. Single-page or short PDFs are a
// fast passthrough so the existing common case keeps its
// non-chunked latency.
//
// opts:
//   eventSink         function(event) called with progress events
//   pageThreshold     chunking kicks in above this many pages
//                     (default CHUNK_PAGE_THRESHOLD)
//   maxPagesPerChunk  pages per dispatched chunk (default
//                     DEFAULT_MAX_PAGES_PER_CHUNK)
//   keepPages         optional, from upstream TOC profiler
//   maxTotalPages     sync ceiling (default SYNC_MAX_TOTAL_PAGES)
export const chunkedExtract = async (args) => {
  const { source, settings, customerId, hints, runCost = null } = args;
  const opts = args.opts || {};
  const eventSink = opts.eventSink || null;
  const t0 = Date.now();

  if (!isPdfSource(source)) {
    // Not a PDF -> straight dispatch. The chunker only handles
    // PDFs; other formats route to their dedicated parsers.
    emit(eventSink, { stage: "passthrough", reason: "not_pdf", duration_ms: 0 });
    return dispatchExtract({ source, settings, customerId, hints, runCost });
  }

  const bytes = toBytes(source);
  if (!bytes) {
    emit(eventSink, { stage: "passthrough", reason: "no_bytes", duration_ms: 0 });
    return dispatchExtract({ source, settings, customerId, hints, runCost });
  }

  let totalPages = 0;
  try {
    totalPages = await probePdfPageCount(bytes);
  } catch (e) {
    // Not a parseable PDF; let the dispatcher handle it (it may
    // route to OCR or fail with a clearer message).
    emit(eventSink, { stage: "passthrough", reason: "probe_failed", error: e?.message || String(e) });
    return dispatchExtract({ source, settings, customerId, hints, runCost });
  }

  const threshold = Number(opts.pageThreshold || CHUNK_PAGE_THRESHOLD);
  if (totalPages <= threshold && !opts.keepPages) {
    emit(eventSink, { stage: "passthrough", reason: "short_pdf", page_count: totalPages });
    return dispatchExtract({ source, settings, customerId, hints, runCost });
  }

  emit(eventSink, { stage: "chunking_started", page_count: totalPages });
  const chunkResult = await chunkPdf(bytes, {
    maxPagesPerChunk: opts.maxPagesPerChunk || DEFAULT_MAX_PAGES_PER_CHUNK,
    keepPages: opts.keepPages,
    maxTotalPages: opts.maxTotalPages || SYNC_MAX_TOTAL_PAGES,
  });
  // Wave 5.3: cross-page table continuation. When the caller
  // provided per-page text snippets (opts.pageTexts), detect
  // tables that span chunk boundaries and plan header
  // replication. The chunker can't rewrite the PDF mid-flight
  // so we surface the plan to the dispatcher via hints so the
  // LLM prompt for the destination chunk carries a
  // "[continuation of table from page X]" note.
  let headerReplication = [];
  if (Array.isArray(opts.pageTexts) && opts.pageTexts.length) {
    const spans = detectSpanningTables(opts.pageTexts);
    if (spans.length) {
      headerReplication = planHeaderReplication(spans, chunkResult.chunks);
      if (headerReplication.length) {
        emit(eventSink, { stage: "header_replication_planned", count: headerReplication.length, plan: headerReplication });
      }
    }
  }
  emit(eventSink, {
    stage: "chunking_complete",
    page_count: chunkResult.totalPages,
    chunk_count: chunkResult.chunks.length,
    duration_ms: chunkResult.duration_ms,
  });

  // Sync chunk extraction runs in bounded-concurrency WAVES rather than one
  // long sequential loop, so wall-clock ≈ the slowest chunk per wave instead
  // of the sum. That is what lets a 20-40 page PO finish inside the 60s
  // function ceiling (vercel.json api/dispatch maxDuration) instead of being
  // shunted to the cron-dependent background worker. Concurrency is modest to
  // stay within provider rate limits; results are written by index so merge
  // order is preserved regardless of completion order.
  const concurrency = Math.max(1, Number(opts.chunkConcurrency || process.env.DOCAI_SYNC_CHUNK_CONCURRENCY || 4));
  const chunkResults = new Array(chunkResult.chunks.length);
  let budgetBreachedAt = null;

  // Extract one chunk. Always resolves (a thrown adapter becomes a stub) so a
  // single bad chunk can never reject the whole wave and zero the PO.
  const runChunk = async (ch) => {
    emit(eventSink, {
      stage: "chunk_started",
      chunk_index: ch.index,
      chunk_count: chunkResult.chunks.length,
      page_start: ch.pageStart,
      page_end: ch.pageEnd,
      page_count: ch.pageCount,
    });
    const tChunk = Date.now();
    try {
      const replication = headerReplication.find((p) => p.chunk_index === ch.index);
      const out = await dispatchExtract({
        source: { ...source, bytes: ch.buffer },
        settings,
        customerId,
        hints: {
          ...hints,
          chunk_index: ch.index,
          chunk_count: chunkResult.chunks.length,
          page_start: ch.pageStart,
          page_end: ch.pageEnd,
          ...(replication ? {
            table_continuation: {
              header_page: replication.header_page,
              span_from: replication.span_from,
              span_to: replication.span_to,
            },
          } : {}),
        },
        runCost,
      });
      emit(eventSink, {
        stage: "chunk_done",
        chunk_index: ch.index,
        chunk_count: chunkResult.chunks.length,
        page_start: ch.pageStart,
        page_end: ch.pageEnd,
        ok: !!out.ok,
        duration_ms: Date.now() - tChunk,
        adapter_used: out.adapter_used || null,
      });
      return out;
    } catch (e) {
      // Best-effort: a failed chunk leaves a stub result so the merger doesn't
      // lose chunk-ordering. Operator can re-run extraction.
      emit(eventSink, {
        stage: "chunk_failed",
        chunk_index: ch.index,
        page_start: ch.pageStart,
        page_end: ch.pageEnd,
        error: e?.message || String(e),
        duration_ms: Date.now() - tChunk,
      });
      return { ok: false, reason: "adapter_threw", error: e?.message || String(e), lines: [], customer: null, confidences: {}, attempts: [] };
    }
  };

  for (let i = 0; i < chunkResult.chunks.length; i += concurrency) {
    // Wave 1.4 circuit breaker, now at wave granularity: if the per-extraction
    // cost cap is already blown, skip every remaining chunk. Over-spend is
    // bounded to at most one in-flight wave.
    if (runCost && runCost.hasExceeded()) {
      budgetBreachedAt = chunkResult.chunks[i].index;
      for (let k = i; k < chunkResult.chunks.length; k++) {
        const ch = chunkResult.chunks[k];
        chunkResults[k] = {
          ok: false,
          reason: "over_run_budget",
          error: "per-extraction cost cap reached",
          accumulated_cost_usd: runCost.totalUsd,
          cap_usd: runCost.cap,
          lines: [], customer: null, confidences: {}, attempts: [],
        };
        emit(eventSink, {
          stage: "chunk_skipped_over_budget",
          chunk_index: ch.index,
          accumulated_cost_usd: runCost.totalUsd,
          cap_usd: runCost.cap,
        });
      }
      break;
    }
    const wave = chunkResult.chunks.slice(i, i + concurrency);
    const waveOut = await Promise.all(wave.map(runChunk));
    waveOut.forEach((out, j) => { chunkResults[i + j] = out; });
  }

  emit(eventSink, { stage: "merging_results", chunk_count: chunkResult.chunks.length });
  const merged = mergeChunkResults(chunkResults, chunkResult.chunks);
  if (budgetBreachedAt != null) {
    merged.over_run_budget = true;
    merged.budget_breached_at_chunk = budgetBreachedAt;
  }
  emit(eventSink, {
    stage: "done",
    chunk_count: chunkResult.chunks.length,
    duration_ms: Date.now() - t0,
    ok: !!merged.ok,
    line_count: merged.lines?.length || 0,
    budget_breached_at_chunk: budgetBreachedAt,
  });
  return merged;
};

export const __test = { isPdfSource, toBytes, mostCommon };
