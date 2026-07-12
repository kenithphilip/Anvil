// GET /api/orders/extraction_status?order_id=<uuid>
//
// Phase B1 of the DocAI robustness work. Returns the live state
// of the most recent extraction run for an order so the recon
// workspace's progress component can poll every 2 seconds and
// render "profiling page 12 of 70" / "extracting chunk 2 of 5" /
// "done · 18 lines extracted" without the operator staring at a
// black-box spinner.
//
// State is derived from processing_events the pipeline writes
// via recordEvent. Three signal classes are surfaced:
//
//   - profile  TOC profiler progress (docai_profiler_started,
//              docai_profiler_done)
//   - chunk    chunker + per-chunk extraction (docai_chunk_*)
//   - run      pipeline boundaries (docai_extract_started,
//              docai_extract_completed)
//
// Polling discipline. The component should stop polling on a
// terminal event_type or after a wall-clock timeout. The
// endpoint itself is read-only and cheap (one indexed query) so
// over-polling is not a correctness issue.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const PROFILER_STAGES = new Set(["docai_profiler_started", "docai_profiler_done"]);
const CHUNK_STAGES = new Set([
  "docai_chunk_passthrough",
  "docai_chunk_chunking_started",
  "docai_chunk_chunking_complete",
  "docai_chunk_chunk_started",
  "docai_chunk_chunk_done",
  "docai_chunk_chunk_failed",
  "docai_chunk_merging_results",
  "docai_chunk_done",
]);
const RUN_STAGES = new Set([
  "docai_extract_started",
  "docai_text_layer_extracted",
  "docai_ocr_layer_extracted",
  "docai_template_applied",
  "docai_extract_completed",       // legacy success name (kept for back-compat)
  "docai_extract_succeeded",       // actual success terminal emitted by run.js
  "docai_extract_low_confidence",  // terminal: produced output but below threshold
  "docai_extract_failed",
]);

// Derive a single human-readable current_stage from the most
// recent event. Operator-facing copy stays terse; the raw event
// stream is in `events` for power users.
const stageLabel = (evt) => {
  if (!evt) return "idle";
  const type = evt.event_type;
  const d = evt.detail || {};
  if (type === "docai_extract_started") return "starting extraction";
  if (type === "docai_text_layer_extracted") return "reading text layer";
  if (type === "docai_ocr_layer_extracted") return "running OCR";
  if (type === "docai_template_applied") return "applying customer template";
  if (type === "docai_profiler_started") {
    return d.page_count ? "profiling " + d.page_count + "-page document" : "profiling document";
  }
  if (type === "docai_profiler_done") {
    const n = (d.line_item_pages || []).length;
    return d.ok
      ? "profile done · " + n + " line-item page" + (n === 1 ? "" : "s") + " identified"
      : "profile inconclusive · reading every page";
  }
  if (type === "docai_chunk_passthrough") return "extracting";
  if (type === "docai_chunk_chunking_started") return "splitting document into chunks";
  if (type === "docai_chunk_chunking_complete") {
    return "chunked into " + (d.chunk_count || "?") + " parts";
  }
  if (type === "docai_chunk_chunk_started") {
    const idx = (typeof d.chunk_index === "number") ? d.chunk_index + 1 : "?";
    const tot = d.chunk_count || "?";
    return "extracting chunk " + idx + " of " + tot
      + (d.page_start ? " (pages " + d.page_start + "-" + d.page_end + ")" : "");
  }
  if (type === "docai_chunk_chunk_done") {
    const idx = (typeof d.chunk_index === "number") ? d.chunk_index + 1 : "?";
    const tot = d.chunk_count || "?";
    return "chunk " + idx + " of " + tot + " done";
  }
  if (type === "docai_chunk_chunk_failed") {
    return "chunk failed · " + (d.error || "unknown");
  }
  if (type === "docai_chunk_merging_results") return "merging chunk results";
  if (type === "docai_chunk_done") {
    const n = d.line_count || 0;
    return "done · " + n + " line" + (n === 1 ? "" : "s") + " extracted";
  }
  if (type === "docai_extract_completed") return "complete";
  if (type === "docai_extract_succeeded") return "complete";
  if (type === "docai_extract_low_confidence") return "complete · low confidence";
  if (type === "docai_extract_failed") return "failed · " + (d.error || "unknown");
  return type;
};

// Reduce the event stream into a structured progress snapshot.
// Events arrive newest-first (the endpoint sorts that way for
// the UI's event log). We iterate in CHRONOLOGICAL order so a
// later docai_extract_completed correctly overrides an earlier
// docai_extract_started status.
const summarise = (events) => {
  let status = "idle";
  let totalPages = null;
  let lineItemPages = null;
  let chunksTotal = 0;
  let chunksDone = 0;
  let chunksFailed = 0;
  let pageStart = null;
  let pageEnd = null;
  let lineCount = null;
  let extractedAdapters = [];
  let profilerOk = null;
  let lastTerminalReason = null;

  for (const e of [...events].reverse()) {
    const t = e.event_type;
    const d = e.detail || {};
    if (t === "docai_extract_started") status = "running";
    if (t === "docai_extract_completed") { status = "completed"; lineCount = d.line_count ?? lineCount; }
    // run.js emits docai_extract_succeeded (not ..._completed) on success, and
    // docai_extract_low_confidence when it produced output below the confidence
    // threshold. Both are terminal "finished" signals; without recognizing them
    // a small (non-chunked) successful run reports "running" forever.
    if (t === "docai_extract_succeeded") { status = "completed"; lineCount = d.lines_count ?? d.line_count ?? lineCount; }
    if (t === "docai_extract_low_confidence") { status = "completed"; lastTerminalReason = d.status_reason || "low_confidence"; lineCount = d.lines_count ?? d.line_count ?? lineCount; }
    if (t === "docai_extract_failed") { status = "failed"; lastTerminalReason = d.error || null; }
    if (t === "docai_profiler_done") {
      profilerOk = !!d.ok;
      if (Array.isArray(d.line_item_pages)) lineItemPages = d.line_item_pages;
      if (typeof d.page_count === "number") totalPages = d.page_count;
    }
    if (t === "docai_profiler_started") {
      if (typeof d.page_count === "number") totalPages = d.page_count;
    }
    if (t === "docai_chunk_chunking_complete") {
      chunksTotal = d.chunk_count || chunksTotal;
      if (typeof d.page_count === "number") totalPages = totalPages || d.page_count;
    }
    if (t === "docai_chunk_chunk_started") {
      chunksTotal = d.chunk_count || chunksTotal;
      pageStart = d.page_start ?? pageStart;
      pageEnd = d.page_end ?? pageEnd;
    }
    if (t === "docai_chunk_chunk_done") { chunksDone++; if (d.adapter_used) extractedAdapters.push(d.adapter_used); }
    if (t === "docai_chunk_chunk_failed") chunksFailed++;
    if (t === "docai_chunk_done") {
      status = status === "failed" ? status : "completed";
      lineCount = d.line_count ?? lineCount;
    }
  }
  const newest = events[0] || null;
  return {
    status,
    current_stage: stageLabel(newest),
    last_event_at: newest?.created_at || null,
    page_count: totalPages,
    line_item_pages: lineItemPages,
    chunks_total: chunksTotal,
    chunks_done: chunksDone,
    chunks_failed: chunksFailed,
    page_start: pageStart,
    page_end: pageEnd,
    line_count: lineCount,
    adapters_used: Array.from(new Set(extractedAdapters)),
    profiler_ok: profilerOk,
    last_terminal_reason: lastTerminalReason,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method !== "GET") {
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const orderId = req.query.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });

    const svc = serviceClient();
    // The pipeline records every progress event with case_id =
    // orderId. We bound the read to the most recent 200 events
    // since the start of a fresh extraction is usually within
    // the last 5 minutes; older runs are unlikely to be the one
    // the operator is watching.
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data, error } = await svc
      .from("processing_events")
      .select("event_type, detail, duration_ms, created_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("case_id", orderId)
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const events = data || [];
    const docaiEvents = events.filter((e) =>
      PROFILER_STAGES.has(e.event_type)
      || CHUNK_STAGES.has(e.event_type)
      || RUN_STAGES.has(e.event_type),
    );
    const summary = summarise(docaiEvents);
    return json(res, 200, {
      order_id: orderId,
      ...summary,
      events: docaiEvents.slice(0, 30), // most-recent 30 for the UI's event log
    });
  } catch (err) {
    sendError(res, err);
  }
}

// Test seam: expose the pure summariser so a unit test can
// drive it without standing up a DB.
export const __test = { summarise, stageLabel, RUN_STAGES };
