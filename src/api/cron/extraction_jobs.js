// Cron worker that drains the extraction_jobs queue.
//
// Phase C2. Runs on every /api/cron/tick fan-out. Picks up the
// oldest queued or in-flight job whose lease has expired, runs
// ONE advancement step (profile, chunk, extract a single chunk,
// or merge), and yields back to the next tick. A 70-page PO
// thus spans ~5 ticks; a 200-page tender spans ~20-30.
//
// One step per tick keeps each invocation comfortably inside
// the Vercel 60-second function ceiling even on the slowest
// chunk. Per-tick budget is hard-bounded by cron-mux's
// per-handler timeout (currently 20s by default; Phase 1 F10).
//
// Worker safety:
//   1. Lease (lease_until) prevents two ticks from grabbing the
//      same row. 30-second TTL, renewed on each step.
//   2. Per-chunk attempts bounded; after MAX_CHUNK_ATTEMPTS we
//      mark the chunk failed and continue to the next.
//   3. State transitions are persisted before the work itself
//      so a crashed worker leaves the row in a recoverable
//      state.
//
// Progress eventing: every advancement writes a processing_events
// row keyed by (tenant_id, case_id=order_id). The
// ExtractionProgress component on the recon table polls
// /api/orders/extraction_status and renders the same bar that
// drives sync extractions.

import { serviceClient } from "../_lib/supabase.js";
import { recordEvent, recordAudit } from "../_lib/audit.js";
import { chunkPdf, probePdfPageCount, BACKGROUND_MAX_TOTAL_PAGES } from "../_lib/docai/pdf-chunker.js";
import { profileDocument } from "../_lib/docai/toc-profiler.js";
import { mergeChunkResults, normalizedResult } from "../_lib/docai/chunked-extract.js";
import { dispatchExtract } from "../_lib/docai/index.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { getPromptVersion, promptNameForKind } from "../_lib/docai/prompt-versions.js";

// Real tenant settings, cached for the life of one tick.
//
// This worker used to hand dispatchExtract a SYNTHETIC settings object —
// literally `{ tenant_id }` — so the background path, which handles the
// LARGEST and most failure-prone documents, ran on defaults for everything:
//
//   - docai_gemini_api_key_enc / docai_creds_iv: absent, so every adapter fell
//     through to the platform env key. A tenant that had configured its own
//     provider key was silently not using it, and the spend landed on the
//     wrong account.
//   - docai_provider_order: absent, so the tenant's pinned order was ignored.
//   - docai_daily_limits: absent, so allowedToCall returned `allowed` every
//     time. But recordCall still fired with the tenant id — so background
//     chunks INCREMENTED the daily counter while being exempt from the cap
//     they were charging against. A 40-chunk PO could exhaust the day's budget
//     and then block the interactive sync path, which does honour it.
//   - docai_fallback_confidence, docai_anthropic_model, docai_gemini_model:
//     absent, so per-tenant quality/model choices did not apply.
//
// Falls back to the old synthetic object if the read fails, because a settings
// hiccup must never strand a job that would otherwise extract.
const settingsForTenant = async (svc, tenantId, cache) => {
  if (cache.has(tenantId)) return cache.get(tenantId);
  let resolved;
  try {
    resolved = (await tenantSettings(svc, tenantId)) || { tenant_id: tenantId };
    if (!resolved.tenant_id) resolved = { ...resolved, tenant_id: tenantId };
  } catch (_e) {
    resolved = { tenant_id: tenantId };
  }
  cache.set(tenantId, resolved);
  return resolved;
};

// The A/B prompt variant for this JOB — resolved once and applied to every
// chunk, because a document split across two arms is not an observation of
// either. Keyed on document_id so the assignment is per document and stable
// across ticks and retries (the same job always lands in the same arm).
//
// What kind of document this job is.
//
// Migration 219 put the kind on the row, so the worker states it instead of
// deducing it. Before that it had to infer "po" from order_id — true then only
// because the enqueue handler requires an order and both callers are PO flows,
// and silently wrong the moment anything else queues a document.
//
// Null means the row predates the column (or the migration is not applied
// yet), and those rows really were purchase orders, because nothing else could
// create one. Reading them as 'po' is a statement about history, not a guess
// about the future — hence the column, so tomorrow's rows say it outright.
export const kindOfJob = (job) => job?.extraction_kind || (job?.order_id ? "po" : null);

const variantHintsFor = (job, settings) => {
  const kind = kindOfJob(job);
  if (!kind) return null;
  if (settings?.docai_prompt_variants !== true) return null;
  const name = promptNameForKind(kind);
  if (!name) return null;
  const choice = getPromptVersion(name, {
    tenantId: job.tenant_id,
    customerId: job.customer_id,
    splitKey: job.document_id || job.id,
    pin: settings?.docai_prompt_pins?.[name] || null,
    allowVariants: true,
  });
  if (!choice?.is_variant || !Array.isArray(choice.system_append) || !choice.system_append.length) return null;
  return { promptVariant: { name: choice.name, version: choice.version, system_append: choice.system_append } };
};

const LEASE_TTL_MS = 30 * 1000;
const MAX_CHUNK_ATTEMPTS = 3;
const PER_TICK_BUDGET_MS = 18_000;        // leave 2s of headroom inside the 20s cron-mux budget
const MAX_JOBS_PER_TICK = 3;              // process up to N distinct jobs per tick

const isCron = (req) => {
  const expected = process.env.CRON_SECRET || "";
  if (!expected) return false;
  return (req.headers?.authorization || "") === "Bearer " + expected;
};

// Pull the oldest non-terminal jobs whose lease has expired.
// The query is intentionally tenant-agnostic; cron runs system
// wide and bears tenant_id on every persisted result.
const pickJobs = async (svc, limit) => {
  const now = new Date().toISOString();
  const r = await svc.from("extraction_jobs")
    .select("*")
    .in("status", ["queued", "profiling", "chunking", "extracting", "merging"])
    .or("lease_until.is.null,lease_until.lt." + now)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (r.error) throw new Error("extraction_jobs queue read: " + r.error.message);
  return r.data || [];
};

// Soft-lease a job. Returns true if we acquired the lease (no
// other worker beat us to it), false otherwise.
const acquireLease = async (svc, job) => {
  const newLease = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const r = await svc.from("extraction_jobs")
    .update({ lease_until: newLease, started_at: job.started_at || new Date().toISOString(), attempts: job.attempts + 1 })
    .eq("id", job.id)
    .or("lease_until.is.null,lease_until.lt." + new Date().toISOString())
    .select("id, lease_until, attempts");
  if (r.error) {
    // eslint-disable-next-line no-console
    console.warn("[cron/extraction_jobs] lease error " + job.id + ": " + r.error.message);
    return false;
  }
  return Array.isArray(r.data) && r.data.length > 0;
};

const emit = async (svc, tenantCtx, eventType, detail) => {
  try {
    await recordEvent(tenantCtx, {
      eventType,
      objectType: "extraction_job",
      objectId: detail?.job_id || null,
      caseId: detail?.order_id || null,
      detail,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[cron/extraction_jobs] event " + eventType + " failed: " + (e?.message || e));
  }
};

// Pull the source bytes for a job. Two modes: (a) storage_path
// is the Supabase storage object path; (b) document_id resolves
// to a documents row that carries either a storage path or a
// URL. Either way the worker reads bytes anew on each tick
// because Vercel functions are stateless across invocations.
const loadSourceBytes = async (svc, job) => {
  if (job.storage_path) {
    const { data, error } = await svc.storage.from("documents").download(job.storage_path);
    if (error) throw new Error("storage download " + job.storage_path + ": " + error.message);
    const buf = Buffer.from(await data.arrayBuffer());
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (job.document_id) {
    const d = await svc.from("documents")
      .select("storage_path, storage_bucket, signed_url, mime")
      .eq("tenant_id", job.tenant_id)
      .eq("id", job.document_id)
      .maybeSingle();
    if (d.data?.storage_path) {
      const bucket = d.data.storage_bucket || "documents";
      const dl = await svc.storage.from(bucket).download(d.data.storage_path);
      if (dl.error) throw new Error("documents storage download: " + dl.error.message);
      const buf = Buffer.from(await dl.data.arrayBuffer());
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  }
  throw new Error("no source bytes available for job " + job.id);
};

// One advancement step. Reads the current state, performs the
// next action (profile / chunk-once / merge), writes the new
// state back. Returns the updated job row + a flag whether more
// work remains.
const advanceJob = async (svc, job, settingsCache = new Map()) => {
  const tenantCtx = { tenantId: job.tenant_id };
  const orderId = job.order_id;

  // STAGE 1: PROFILING
  if (job.status === "queued" || job.status === "profiling") {
    await emit(svc, tenantCtx, "docai_profiler_started", { job_id: job.id, order_id: orderId, page_count: job.total_pages || null });
    const bytes = await loadSourceBytes(svc, job);
    let totalPages = job.total_pages;
    if (!totalPages) {
      try { totalPages = await probePdfPageCount(bytes); }
      catch (_e) { totalPages = null; }
    }
    let profile = null;
    if (totalPages && totalPages >= 10) {
      profile = await profileDocument({
        source: { bytes, mime: job.source_mime || "application/pdf" },
        tenantId: job.tenant_id,
        svc,
      }).catch((err) => ({ ok: false, error: err?.message || String(err), line_item_pages: [], confidence: 0 }));
    }
    const keepPages = profile?.ok ? profile.line_item_pages : null;
    await emit(svc, tenantCtx, "docai_profiler_done", {
      job_id: job.id,
      order_id: orderId,
      ok: !!profile?.ok,
      classification: profile?.classification || null,
      confidence: profile?.confidence || 0,
      page_count: totalPages,
      line_item_pages: keepPages || [],
      reason: profile?.reason || null,
    });
    const upd = await svc.from("extraction_jobs")
      .update({
        status: "chunking",
        total_pages: totalPages,
        profiler_result: profile || null,
        keep_pages: keepPages || null,
        lease_until: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      })
      .eq("id", job.id)
      .select("*").single();
    if (upd.error) throw new Error("job update (profile): " + upd.error.message);
    return { job: upd.data, hasMore: true };
  }

  // STAGE 2: CHUNKING. Materialise the chunks once and persist
  // a chunk_status array so the per-chunk loop can iterate
  // across ticks.
  if (job.status === "chunking") {
    await emit(svc, tenantCtx, "docai_chunk_chunking_started", { job_id: job.id, order_id: orderId, page_count: job.total_pages });
    const bytes = await loadSourceBytes(svc, job);
    const chunkResult = await chunkPdf(bytes, {
      maxPagesPerChunk: 5,
      keepPages: job.keep_pages || null,
      maxTotalPages: BACKGROUND_MAX_TOTAL_PAGES,
    });
    await emit(svc, tenantCtx, "docai_chunk_chunking_complete", {
      job_id: job.id, order_id: orderId,
      page_count: chunkResult.totalPages, chunk_count: chunkResult.chunks.length,
    });
    // Store chunk_status without the bytes; we re-materialise
    // bytes on each tick rather than persisting them (they would
    // bloat the row and we already have the source).
    const chunkStatus = chunkResult.chunks.map((c) => ({
      index: c.index,
      page_start: c.pageStart,
      page_end: c.pageEnd,
      page_count: c.pageCount,
      status: "pending",
      attempts: 0,
    }));
    const upd = await svc.from("extraction_jobs")
      .update({
        status: chunkStatus.length ? "extracting" : "merging",
        chunk_status: chunkStatus,
        next_chunk_index: 0,
        lease_until: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      })
      .eq("id", job.id)
      .select("*").single();
    if (upd.error) throw new Error("job update (chunk): " + upd.error.message);
    return { job: upd.data, hasMore: true };
  }

  // STAGE 3: EXTRACTING. Run one chunk per tick.
  if (job.status === "extracting") {
    const list = Array.isArray(job.chunk_status) ? [...job.chunk_status] : [];
    const idx = list.findIndex((c) => c.status === "pending" || c.status === "retry");
    if (idx === -1) {
      // No pending chunks; advance to merge.
      const upd = await svc.from("extraction_jobs")
        .update({ status: "merging", lease_until: new Date(Date.now() + LEASE_TTL_MS).toISOString() })
        .eq("id", job.id).select("*").single();
      if (upd.error) throw new Error("job update (extract->merge): " + upd.error.message);
      return { job: upd.data, hasMore: true };
    }
    const chunkMeta = list[idx];
    await emit(svc, tenantCtx, "docai_chunk_chunk_started", {
      job_id: job.id, order_id: orderId,
      chunk_index: chunkMeta.index,
      chunk_count: list.length,
      page_start: chunkMeta.page_start,
      page_end: chunkMeta.page_end,
      page_count: chunkMeta.page_count,
    });
    const t0 = Date.now();
    let chunkOk = false;
    let chunkResult = null;
    let chunkErr = null;
    try {
      // Re-materialise the chunk's pages from the source. The
      // chunker is deterministic; same input + same keep list
      // produces the same byte ranges.
      const bytes = await loadSourceBytes(svc, job);
      const re = await chunkPdf(bytes, {
        maxPagesPerChunk: 5,
        keepPages: job.keep_pages || null,
        maxTotalPages: BACKGROUND_MAX_TOTAL_PAGES,
      });
      const target = re.chunks[idx];
      if (!target) throw new Error("chunk index " + idx + " out of range after re-chunk");
      const settings = await settingsForTenant(svc, job.tenant_id, settingsCache);
      const out = await dispatchExtract({
        source: { bytes: target.buffer, mime: "application/pdf", filename: job.source_filename || "chunk.pdf" },
        settings,
        customerId: job.customer_id,
        hints: {
          chunk_index: idx, chunk_count: re.chunks.length,
          page_start: chunkMeta.page_start, page_end: chunkMeta.page_end,
          // Tell the adapter what it is reading. Absent, it defaults to the
          // purchase-order schema and would ask a quotation for a po_number.
          // Omitted rather than defaulted when the kind is unknown, so the
          // adapter's own default stays the single place that decision lives.
          ...(kindOfJob(job) ? { expectedKind: kindOfJob(job) } : {}),
          ...(variantHintsFor(job, settings) || {}),
        },
      });
      chunkOk = !!out.ok;
      chunkResult = out;
      // A dispatch that returns not-ok does not THROW, so last_error stayed
      // null and a failed chunk recorded no reason at all. That mattered
      // little while this path ignored docai_daily_limits — nothing here could
      // be refused. Now that real settings are loaded, the honest new failure
      // is "every adapter was over the tenant's daily budget", and an operator
      // who cannot see that reason cannot act on it.
      if (!chunkOk) {
        // Budget FIRST, then the generic error. The other way round — which is
        // how this shipped — let dispatchExtract's catch-all "no docai adapter
        // configured" win, so the branch written for the capped case never
        // once ran in it.
        const overBudget = (out?.attempts || []).filter((a) => a.status === "skipped_over_budget");
        chunkErr = (overBudget.length ? "over daily budget: " + overBudget.map((a) => a.adapter).join(", ") : null)
          || out?.error
          || out?.reason
          || null;
      }
    } catch (e) {
      chunkErr = e?.message || String(e);
    }
    list[idx] = {
      ...chunkMeta,
      attempts: (chunkMeta.attempts || 0) + 1,
      status: chunkOk ? "done" : (chunkMeta.attempts + 1 >= MAX_CHUNK_ATTEMPTS ? "failed" : "retry"),
      adapter_used: chunkResult?.adapter_used || null,
      // Per-chunk lines live under `.normalized` (dispatchExtract shape); read
      // via the shared accessor so a flat read can't silently report 0.
      line_count: (normalizedResult(chunkResult).lines || []).length,
      duration_ms: Date.now() - t0,
      completed_at: chunkOk ? new Date().toISOString() : null,
      last_error: chunkErr,
    };
    await emit(svc, tenantCtx, chunkOk ? "docai_chunk_chunk_done" : "docai_chunk_chunk_failed", {
      job_id: job.id, order_id: orderId,
      chunk_index: chunkMeta.index,
      chunk_count: list.length,
      page_start: chunkMeta.page_start,
      page_end: chunkMeta.page_end,
      duration_ms: Date.now() - t0,
      ok: chunkOk,
      adapter_used: chunkResult?.adapter_used || null,
      error: chunkErr,
    });
    // Accumulate the chunk's normalised output into partial_result.
    const partial = job.partial_result && typeof job.partial_result === "object" ? job.partial_result : {};
    const chunkResults = Array.isArray(partial.chunk_results) ? [...partial.chunk_results] : [];
    chunkResults[idx] = chunkOk ? chunkResult : { ok: false, error: chunkErr, lines: [], customer: null, confidences: {}, attempts: [] };
    partial.chunk_results = chunkResults;
    const nextStatus = list.some((c) => c.status === "pending" || c.status === "retry") ? "extracting" : "merging";
    const upd = await svc.from("extraction_jobs")
      .update({
        chunk_status: list,
        partial_result: partial,
        next_chunk_index: list.findIndex((c) => c.status === "pending" || c.status === "retry"),
        status: nextStatus,
        lease_until: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      })
      .eq("id", job.id).select("*").single();
    if (upd.error) throw new Error("job update (chunk done): " + upd.error.message);
    return { job: upd.data, hasMore: true };
  }

  // STAGE 4: MERGING. Compose final result + write back to orders.
  if (job.status === "merging") {
    await emit(svc, tenantCtx, "docai_chunk_merging_results", {
      job_id: job.id, order_id: orderId, chunk_count: (job.chunk_status || []).length,
    });
    const chunkResults = job.partial_result?.chunk_results || [];
    const chunks = (job.chunk_status || []).map((c) => ({ pageStart: c.page_start, pageEnd: c.page_end, pageCount: c.page_count }));
    const merged = mergeChunkResults(chunkResults, chunks);
    // mergeChunkResults returns the nested `normalized` shape (lines/customer
    // under .normalized); read through the shared accessor. Reading flat
    // `merged.lines`/`merged.customer` here is exactly what zero-lined every
    // chunked background PO while the job still reported 'completed'.
    const mergedNorm = normalizedResult(merged);
    const mergedLines = Array.isArray(mergedNorm.lines) ? mergedNorm.lines : [];

    // Honor a mid-flight operator cancel: if the job was cancelled while this
    // tick held the lease, don't write the order or mark it completed.
    const cur = await svc.from("extraction_jobs").select("status").eq("id", job.id).maybeSingle();
    if (cur.data && cur.data.status === "cancelled") return { job, hasMore: false };

    // If EVERY chunk failed (merged.ok === false), FAIL the job — do NOT blank
    // the order's existing line items and report it 'completed' (that turned a
    // total extraction failure into a silently-empty order). A genuinely empty
    // document still has merged.ok === true.
    if (merged && merged.ok === false) {
      const f = await svc.from("extraction_jobs")
        .update({ status: "failed", result: merged, last_error: "all chunks failed to extract", completed_at: new Date().toISOString(), lease_until: null })
        .eq("id", job.id).eq("status", "merging").select("*").maybeSingle();
      if (f.error) throw new Error("job update (merge-fail): " + f.error.message);
      await emit(svc, tenantCtx, "docai_extract_failed", { job_id: job.id, order_id: orderId, error: "all chunks failed" });
      await recordAudit({ tenantId: job.tenant_id }, { action: "extraction_job_failed", objectType: "extraction_job", objectId: job.id, after: { reason: "all_chunks_failed" } });
      return { job: (f.data || job), hasMore: false };
    }

    // Persist into the parent order: same shape as runExtraction
    // writes for the sync flow, so downstream code (recon table,
    // anomaly compute) consumes it identically.
    //
    // ONLY for the purchase-order shapes. orders.result.salesOrder.lineItems is
    // the PO's own lines — what the customer ordered — and the reconciler,
    // the approval gate and the Tally push all read it. Writing a quotation's
    // or a packing list's lines there would not be a display bug; it would
    // replace the order's contents with another document's. Now that a job can
    // declare a kind, that has to be refused explicitly rather than prevented
    // by the accident that nothing else could ever be queued.
    //
    // A kind with no writeback is completed, not failed: the extraction
    // succeeded and the merged result is durable in extraction_jobs.result.
    // The event says so, so it is visible rather than silently parked.
    const jobKind = kindOfJob(job) || "po";
    const PO_SHAPED = new Set(["po", "rfq", "generic"]);
    if (orderId && !PO_SHAPED.has(jobKind)) {
      await emit(svc, tenantCtx, "docai_chunk_merged_no_writeback", {
        job_id: job.id, order_id: orderId, kind: jobKind,
        line_count: mergedLines.length,
        detail: "extracted " + mergedLines.length + " lines; kind '" + jobKind
          + "' has no background writeback, result kept on the job",
      });
    }
    if (orderId && PO_SHAPED.has(jobKind)) {
      const ord = await svc.from("orders").select("result, preflight_payload").eq("tenant_id", job.tenant_id).eq("id", orderId).maybeSingle();
      if (ord.error) throw new Error("order read (merge): " + ord.error.message);
      const nextResult = { ...(ord.data?.result || {}) };
      nextResult.salesOrder = {
        ...(nextResult.salesOrder || {}),
        lineItems: mergedLines,
        customer: mergedNorm.customer || nextResult.salesOrder?.customer || null,
      };
      const nextPreflight = {
        ...(ord.data?.preflight_payload || {}),
        adapter_used: merged.adapter_used || null,
        confidence_overall: merged.confidence_overall || null,
        last_extracted_at: new Date().toISOString(),
        extraction_job_id: job.id,
      };
      const wb = await svc.from("orders")
        .update({ result: nextResult, preflight_payload: nextPreflight })
        .eq("tenant_id", job.tenant_id).eq("id", orderId);
      if (wb.error) {
        // Do NOT swallow a writeback failure into 'completed' — that strands the
        // order with un-written lines while the job claims success. Fail the job
        // (extraction result preserved in job.result for recovery) so it is
        // visible instead of silently wrong.
        const f = await svc.from("extraction_jobs")
          .update({ status: "failed", result: merged, last_error: "order writeback failed: " + wb.error.message, completed_at: new Date().toISOString(), lease_until: null })
          .eq("id", job.id).eq("status", "merging").select("*").maybeSingle();
        if (f.error) throw new Error("job update (writeback-fail): " + f.error.message);
        await emit(svc, tenantCtx, "docai_extract_failed", { job_id: job.id, order_id: orderId, error: "writeback: " + wb.error.message });
        return { job: (f.data || job), hasMore: false };
      }
    }
    // TELL extraction_runs WHAT ACTUALLY CAME OUT.
    //
    // A document over the background threshold is extracted TWICE: once
    // synchronously with hints.keepPages=[1] — which opens a real
    // extraction_runs row describing a PAGE-1 STUB — and once here, in full,
    // writing nothing. So the only quality record of a 200-page tender was a
    // row reporting whatever page 1 happened to contain, at page 1's
    // confidence. Every measurement built on that table — the governed
    // extraction metrics, the operator-corrected DPMO, the golden harvest, the
    // prompt A/B read-out — was blind to the largest documents in the product
    // and quietly measuring a stub in their place.
    //
    // extraction_jobs has no extraction_run_id column, but extraction_runs
    // .source_id IS the document id, so the job resolves its own run. Updating
    // the outcome fields rather than inserting a second row keeps one document
    // to one run; the page-1 preview's cost is already banked in docai_usage,
    // and field_confidences is replaced along with the extract so lineCountOf
    // cannot report page 1's line count against the full document's lines.
    //
    // Strictly best-effort: extraction_jobs.result is the durable record, and
    // a quality-telemetry failure must never fail a job that extracted fine.
    if (job.document_id) {
      try {
        const runQ = await svc.from("extraction_runs")
          .select("id, status_reason")
          .eq("tenant_id", job.tenant_id)
          .eq("source_id", job.document_id)
          .order("finished_at", { ascending: false, nullsFirst: false })
          .limit(5);
        const target = (runQ.data || []).find((r) => r.status_reason !== "dedupe_hit");
        if (target) {
          const variant = variantHintsFor(job, await settingsForTenant(svc, job.tenant_id, settingsCache));
          const patch = {
            normalized_extract: mergedNorm,
            field_confidences: merged.confidences || {},
            confidence_overall: merged.confidence_overall ?? null,
            adapter_used: merged.adapter_used || null,
            adapter_attempts: merged.attempts || [],
            selected_model: merged.selected_model || null,
            model_selection_reason: merged.model_selection_reason || null,
            status: mergedLines.length ? "ok" : "failed",
            status_reason: mergedLines.length ? "ok" : "empty_lines",
            finished_at: new Date().toISOString(),
            ...(variant ? {
              prompt_version: {
                name: variant.promptVariant.name,
                version: variant.promptVariant.version,
                source: "background_job",
                is_variant: true,
                label: `${variant.promptVariant.name}@${variant.promptVariant.version}`,
              },
            } : {}),
          };
          let w = await svc.from("extraction_runs").update(patch).eq("id", target.id);
          if (w.error && (w.error.code === "42703" || /prompt_version/.test(w.error.message || ""))) {
            const retry = { ...patch };
            delete retry.prompt_version;
            w = await svc.from("extraction_runs").update(retry).eq("id", target.id);
          }
        }
      } catch (_e) { /* telemetry only — never fail the job for it */ }
    }

    const upd = await svc.from("extraction_jobs")
      .update({
        status: "completed",
        result: merged,
        completed_at: new Date().toISOString(),
        lease_until: null,
      })
      .eq("id", job.id).eq("status", "merging").select("*").maybeSingle();
    if (upd.error) throw new Error("job update (merge): " + upd.error.message);
    // A mid-flight cancel (or another worker) moved the status off 'merging'
    // -> 0 rows updated; don't emit 'completed' for a job we didn't complete.
    if (!upd.data) return { job, hasMore: false };
    await emit(svc, tenantCtx, "docai_chunk_done", {
      job_id: job.id, order_id: orderId,
      line_count: mergedLines.length,
      chunk_count: chunks.length,
    });
    await recordAudit({ tenantId: job.tenant_id }, {
      action: "extraction_job_completed",
      objectType: "extraction_job",
      objectId: job.id,
      after: { line_count: mergedLines.length, chunk_count: chunks.length },
    });
    return { job: upd.data, hasMore: false };
  }

  return { job, hasMore: false };
};

export default async function handler(req, res) {
  if (!isCron(req)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { message: "cron auth required" } }));
  }
  const svc = serviceClient();
  // One settings read per tenant per tick, shared across every job and chunk
  // this tick handles — the same pattern eval/replay.js uses.
  const settingsCache = new Map();
  const tickStart = Date.now();
  let jobsHandled = 0;
  let stepsRun = 0;
  let lastError = null;
  try {
    const jobs = await pickJobs(svc, MAX_JOBS_PER_TICK);
    for (const job of jobs) {
      if (Date.now() - tickStart > PER_TICK_BUDGET_MS) break;
      const got = await acquireLease(svc, job);
      if (!got) continue;
      let current = job;
      let safety = 5;
      while (safety-- > 0 && Date.now() - tickStart < PER_TICK_BUDGET_MS) {
        try {
          const r = await advanceJob(svc, current, settingsCache);
          stepsRun++;
          current = r.job;
          if (!r.hasMore) break;
        } catch (e) {
          lastError = e?.message || String(e);
          // Don't flip an operator-cancelled job to 'failed' (would resurrect it
          // off 'cancelled'); leave terminal states alone.
          await svc.from("extraction_jobs").update({
            status: "failed",
            last_error: lastError,
            completed_at: new Date().toISOString(),
            lease_until: null,
          }).eq("id", current.id).neq("status", "cancelled").neq("status", "completed");
          await emit(svc, { tenantId: current.tenant_id }, "docai_extract_failed", {
            job_id: current.id, order_id: current.order_id, error: lastError,
          });
          break;
        }
      }
      jobsHandled++;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      jobs_handled: jobsHandled,
      steps_run: stepsRun,
      duration_ms: Date.now() - tickStart,
    }));
  } catch (err) {
    /* eslint-disable no-console */
    console.error("[cron/extraction_jobs] " + (err?.message || err));
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: err?.message || String(err), jobs_handled: jobsHandled, steps_run: stepsRun }));
  }
}

// Test seam.
export const __test = { LEASE_TTL_MS, MAX_CHUNK_ATTEMPTS, PER_TICK_BUDGET_MS, advanceJob, settingsForTenant, variantHintsFor, kindOfJob };
