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
import { ingestQuote, quoteHeadFromExtract } from "../_lib/quote-ingest.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { getPromptVersion, promptNameForKind } from "../_lib/docai/prompt-versions.js";
import { extractTextLayer } from "../_lib/docai/text_layer.js";
import { planDensityChunking } from "../_lib/docai/density-plan.js";
import { buildWindowBodyText } from "../_lib/docai/text-row-chunker.js";

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

// A row-window job's plan is re-derived per tick rather than stored, exactly as
// the page chunker re-materialises its bytes. That is only safe while the
// re-derivation is IDENTICAL, so the text this is built from must be complete
// and whole-document -- these guards are the difference between "same plan" and
// "a shorter plan that still indexes in range", which would silently extract
// the WRONG rows and report success.
//
// Returns { ok, bodyText, reason }. Never throws: any doubt falls back to page
// chunking, which is the conservative direction.
const loadBodyText = async (bytes, job) => {
  try {
    const layer = await extractTextLayer({ bytes, mime: job.source_mime || "application/pdf" });
    if (!layer?.body_text) return { ok: false, bodyText: null, reason: "no_text_layer" };
    // 'mixed' means part of the document is scanned: the digital pages have
    // text and the scanned ones do not. Row-planning over that half silently
    // drops every scanned page's items -- and the page path we would be
    // replacing hands those pages to the OCR-capable adapters.
    if (layer.status !== "has_text") return { ok: false, bodyText: null, reason: "text_status_" + (layer.status || "unknown") };
    // The text layer hard-trims at MAX_BODY_TEXT_BYTES. A trimmed body is a
    // DETERMINISTICALLY truncated table: the mismatch check would never fire,
    // every item past the cut would never be windowed, and the job would
    // complete green having dropped them.
    if (Number.isFinite(Number(layer.char_count)) && Number(layer.char_count) > layer.body_text.length) {
      return { ok: false, bodyText: null, reason: "body_text_truncated" };
    }
    return { ok: true, bodyText: layer.body_text, reason: null };
  } catch (_e) {
    return { ok: false, bodyText: null, reason: "text_layer_threw" };
  }
};

// Row-window jobs are marked per chunk-status entry rather than with a new
// column: chunk_status is already the per-chunk jsonb the worker iterates, so
// the mode travels with the very rows it describes and needs no migration.
const isRowChunk = (meta) => meta?.mode === "row";

// Ceiling on row windows per job. The page path has BACKGROUND_MAX_TOTAL_PAGES;
// without an equivalent a pathological table plans an unbounded number of
// generation-tier calls. Above this the job stays on page chunks.
const MAX_ROW_WINDOWS = Math.max(1, Number(process.env.DOCAI_MAX_ROW_WINDOWS) || 80);

// Fingerprint of the planned windows. Pinned on the job at chunking time and
// re-checked every tick: a plan that SHRINKS (window size env changed, source
// re-uploaded, text layer differs) still indexes in range, so without this the
// worker would extract different rows than it planned and never notice.
const planFingerprint = (plan) => {
  const text = plan.windows.map((w) => w.text).join("\n \n");
  let h1 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return plan.windows.length + ":" + plan.itemCount + ":" + h1.toString(16);
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
    // The page profiler is PO-trained and PO-shaped: it classifies a document
    // as po/rfq/amendment/non_po and keeps only the pages it judges to carry
    // line items, explicitly dropping "a header page with no line items".
    //
    // On a quotation that is actively harmful. A quote's page 1 is typically
    // letterhead and the quote NUMBER — no line items — so the profiler drops
    // it, ingestQuote gets no quote_number, and it refuses the whole document
    // before writing anything. The job then fails on a quotation that read
    // perfectly well.
    //
    // Until there is a profiler that understands other kinds, run it only for
    // the kinds it was built for and keep every page for the rest.
    const profilerKind = kindOfJob(job) || "po";
    const PROFILABLE = new Set(["po", "rfq", "generic"]);
    let profile = null;
    if (totalPages && totalPages >= 10 && PROFILABLE.has(profilerKind)) {
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

    // Phase 3b: ROW-WINDOW chunking for a line-dense table. Page chunks cannot
    // split a document whose lines are packed onto few pages, and a 2000-line
    // contract is far past what any single call can hold -- so when the text
    // layer is dense, chunk by ITEM ROWS instead. Nothing about the windows is
    // persisted: planRowWindows is pure over the same text, so each tick
    // re-derives the identical window, exactly as the page path re-materialises
    // its bytes. Falls back to page chunks whenever the plan does not apply.
    const chunkSettings = await settingsForTenant(svc, job.tenant_id, settingsCache);
    let chunkStatus = null;
    let rowPlanned = null;
    let rowPin = null;
    // keep_pages means the profiler decided only SOME pages carry the table.
    // Row windows are built from the whole text layer and would silently pull
    // in the pages it excluded, so the two are mutually exclusive.
    const rowEligible = chunkSettings?.docai_density_chunk_enabled && !job.keep_pages;
    const textForPlan = rowEligible ? await loadBodyText(bytes, job) : { ok: false, reason: "not_eligible" };
    if (textForPlan.ok) {
      const decision = planDensityChunking({
        kind: kindOfJob(job), bodyText: textForPlan.bodyText, settings: chunkSettings,
      });
      if (decision.eligible && decision.windowCount > MAX_ROW_WINDOWS) {
        await emit(svc, tenantCtx, "docai_chunk_row_windows_rejected", {
          job_id: job.id, order_id: orderId, reason: "too_many_windows",
          window_count: decision.windowCount, max: MAX_ROW_WINDOWS,
        });
      } else if (decision.eligible) {
        rowPlanned = decision;
        rowPin = {
          window_count: decision.windowCount,
          item_count: decision.itemCount,
          fingerprint: planFingerprint(decision.plan),
        };
        chunkStatus = decision.plan.windows.map((w) => ({
          index: w.index,
          mode: "row",
          item_count: w.itemCount,
          status: "pending",
          attempts: 0,
        }));
        await emit(svc, tenantCtx, "docai_chunk_row_windows_planned", {
          job_id: job.id, order_id: orderId,
          window_count: decision.windowCount, item_count: decision.itemCount,
        });
      }
    } else if (rowEligible && textForPlan.reason) {
      await emit(svc, tenantCtx, "docai_chunk_row_windows_rejected", {
        job_id: job.id, order_id: orderId, reason: textForPlan.reason,
      });
    }

    let chunkResult = null;
    if (!chunkStatus) {
      chunkResult = await chunkPdf(bytes, {
        maxPagesPerChunk: 5,
        keepPages: job.keep_pages || null,
        maxTotalPages: BACKGROUND_MAX_TOTAL_PAGES,
      });
      // Store chunk_status without the bytes; we re-materialise
      // bytes on each tick rather than persisting them (they would
      // bloat the row and we already have the source).
      chunkStatus = chunkResult.chunks.map((c) => ({
        index: c.index,
        page_start: c.pageStart,
        page_end: c.pageEnd,
        page_count: c.pageCount,
        status: "pending",
        attempts: 0,
      }));
    }
    await emit(svc, tenantCtx, "docai_chunk_chunking_complete", {
      job_id: job.id, order_id: orderId,
      page_count: chunkResult ? chunkResult.totalPages : (job.total_pages || null),
      chunk_count: chunkStatus.length,
      mode: rowPlanned ? "row" : "page",
    });
    const upd = await svc.from("extraction_jobs")
      .update({
        status: chunkStatus.length ? "extracting" : "merging",
        chunk_status: chunkStatus,
        next_chunk_index: 0,
        // Pin the plan the windows were cut from. Every later tick re-derives
        // the plan and must reproduce this exactly; anything else means the
        // windows it is about to extract are not the windows we queued.
        ...(rowPin ? { partial_result: { ...(job.partial_result || {}), row_plan: rowPin } } : {}),
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
      // Re-materialise this chunk from the source. Both chunkers are
      // deterministic -- the page chunker over the same bytes + keep list, the
      // row planner over the same text layer -- so the same index rebuilds the
      // same chunk on every tick without persisting it.
      const bytes = await loadSourceBytes(svc, job);
      const settings = await settingsForTenant(svc, job.tenant_id, settingsCache);

      let source;
      let windowHints = {};
      let chunkCount = list.length;
      if (isRowChunk(chunkMeta)) {
        const text = await loadBodyText(bytes, job);
        if (!text.ok) throw new Error("row plan text unavailable on re-derive (" + text.reason + ")");
        const decision = planDensityChunking({ kind: kindOfJob(job), bodyText: text.bodyText, settings });
        if (!decision.eligible) throw new Error("row plan no longer applies on re-derive (" + decision.reason + ")");
        // VERIFY THE PIN. An out-of-range index is the easy case; the dangerous
        // one is a plan that SHRANK -- it still indexes in range but window N
        // now covers different rows, so we would extract the wrong items and
        // report success. Compare the whole planned shape, not just the count.
        const pin = job.partial_result?.row_plan || null;
        const now = planFingerprint(decision.plan);
        if (pin && pin.fingerprint !== now) {
          throw new Error("ROW_PLAN_DRIFT: planned " + pin.fingerprint + " but re-derived " + now);
        }
        const w = decision.plan.windows[idx];
        if (!w) throw new Error("row window " + idx + " out of range after re-plan");
        // Bytes stripped: only the LLM adapters honour hints.bodyText, and a
        // byte-reading adapter handed the full PDF would extract the WHOLE
        // document for this window (see density-chunk.js).
        source = { bytes: null, url: null, mime: job.source_mime || "application/pdf", filename: job.source_filename || "document.pdf" };
        windowHints = {
          bodyText: buildWindowBodyText(decision.plan, w),
          density_window: idx,
          escalate: true,
        };
        chunkCount = decision.windowCount;
      } else {
        const re = await chunkPdf(bytes, {
          maxPagesPerChunk: 5,
          keepPages: job.keep_pages || null,
          maxTotalPages: BACKGROUND_MAX_TOTAL_PAGES,
        });
        const target = re.chunks[idx];
        if (!target) throw new Error("chunk index " + idx + " out of range after re-chunk");
        source = { bytes: target.buffer, mime: "application/pdf", filename: job.source_filename || "chunk.pdf" };
        chunkCount = re.chunks.length;
      }

      const out = await dispatchExtract({
        source,
        settings,
        customerId: job.customer_id,
        hints: {
          chunk_index: idx, chunk_count: chunkCount,
          page_start: chunkMeta.page_start, page_end: chunkMeta.page_end,
          ...windowHints,
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
    // Row windows carry no page geometry, so weight them by ITEM count -- the
    // merge weights confidence by `pageCount`, and without this every window
    // would count the same whether it held 25 items or 3 (mirrors the sync
    // density path, which passes item counts for the same reason).
    const chunks = (job.chunk_status || []).map((c) => ({
      pageStart: c.page_start,
      pageEnd: c.page_end,
      pageCount: c.page_count ?? c.item_count,
    }));
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

    // A ROW-WINDOW job must be COMPLETE to be written back. Page chunks
    // partition a document that mostly repeats its header, so a lost chunk
    // costs some lines; row windows partition the LINE TABLE ITSELF, so a lost
    // window is a contiguous block of items missing from the middle of the
    // order -- and the writeback below replaces the order's lines (for a quote,
    // ingestQuote replaces them wholesale). A partial row walk that reports
    // 'completed' is therefore silent data loss, not a degraded result. The
    // all-failed gate below cannot catch it because merged.ok is okAny.
    const rowMode = (job.chunk_status || []).some(isRowChunk);
    const failedRowWindows = rowMode
      ? (job.chunk_status || []).filter((c) => c.status === "failed")
      : [];
    if (failedRowWindows.length) {
      const detail = failedRowWindows.length + " of " + (job.chunk_status || []).length
        + " row windows failed; refusing to write a partial line table";
      const f = await svc.from("extraction_jobs")
        .update({ status: "failed", result: merged, last_error: detail, completed_at: new Date().toISOString(), lease_until: null })
        .eq("id", job.id).eq("status", "merging").select("*").maybeSingle();
      await emit(svc, tenantCtx, "docai_chunk_row_windows_incomplete", {
        job_id: job.id, order_id: orderId,
        failed: failedRowWindows.map((c) => c.index),
        window_count: (job.chunk_status || []).length,
      });
      return { job: f.data || job, hasMore: false };
    }

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

    // Quotations DO have a background writeback: the same ingest the sync path
    // uses, re-run with the complete extract.
    //
    // This is safe for one specific reason. ingestQuote is keyed on
    // (tenant, quote_number, version) and REPLACES the quote's lines
    // wholesale, so re-running it does not append a second copy — it
    // supersedes the page-1 lines the upload ingested with the full set. That
    // is precisely the semantics a truncated-then-completed quote needs, and
    // it is why this reuses the ingest rather than writing lines here.
    //
    // It also cannot damage a quote Anvil authored: ingestQuote checks
    // ingest_source (migration 188) and returns early on an authored row
    // before it deletes anything.
    //
    // The ONLY thing it takes off a ctx is tenantId, so a cron can call it
    // honestly — no invented user, no borrowed session.
    if (jobKind === "quote") {
      let wrote = null;
      try {
        wrote = await ingestQuote(svc, { tenantId: job.tenant_id }, {
          quote: quoteHeadFromExtract(mergedNorm),
          lines: mergedLines,
          customerId: job.customer_id || null,
          sourceDocumentId: job.document_id || null,
          ingestSource: "document",
        });
      } catch (e) {
        wrote = { error: e?.message || String(e) };
      }
      if (wrote?.error) {
        // Same rule as the order writeback below: do not swallow a failed
        // writeback into 'completed'. A quote that silently stayed truncated
        // is the exact failure this feature exists to remove.
        // Compare-and-set on status, exactly as the order writeback below does:
        // without `.eq("status","merging")` an operator who cancelled the job
        // mid-flight would see it resurrected from cancelled into failed.
        const f = await svc.from("extraction_jobs")
          .update({ status: "failed", result: merged, last_error: "quote writeback failed: " + wrote.error, completed_at: new Date().toISOString(), lease_until: null })
          .eq("id", job.id).eq("status", "merging").select("*").maybeSingle();
        if (f.error) throw new Error("job update (quote-writeback-fail): " + f.error.message);
        await emit(svc, tenantCtx, "docai_extract_failed", { job_id: job.id, order_id: orderId, error: "quote writeback: " + wrote.error });
        // { job, hasMore } — the shape the driver reads. Returning anything
        // else leaves `current` undefined and only works by accident.
        return { job: (f.data || job), hasMore: false };
      }
      await emit(svc, tenantCtx, "docai_chunk_quote_ingested", {
        job_id: job.id, order_id: orderId,
        quote_id: wrote?.quote_id || null,
        quote_number: wrote?.quote_number || null,
        lines_written: wrote?.lines_written || 0,
        line_count: mergedLines.length,
        // matched_authored means the quote was authored in Anvil and left
        // alone. Not an error, but not an ingest either — say which happened.
        matched_authored: !!wrote?.matched_authored,
        detail: wrote?.matched_authored
          ? "quote was authored in Anvil — kept as-is"
          : "wrote " + (wrote?.lines_written || 0) + " of " + mergedLines.length + " extracted lines",
      });
    }

    if (orderId && !PO_SHAPED.has(jobKind) && jobKind !== "quote") {
      await emit(svc, tenantCtx, "docai_chunk_merged_no_writeback", {
        job_id: job.id, order_id: orderId, kind: jobKind,
        line_count: mergedLines.length,
        detail: "extracted " + mergedLines.length + " lines; kind '" + jobKind
          + "' has no background writeback, result kept on the job",
      });
    }
    // SECOND LINE OF DEFENCE, and it reads the document rather than the label.
    //
    // kindOfJob falls back to "po" for any job that has an order id, so a job
    // whose kind could not be persisted — a database without migration 219 —
    // presents as a PO no matter what was queued. The enqueue now refuses to
    // create such a job for a non-PO kind, but a row queued BEFORE that fix is
    // already in the table, and this branch is what would overwrite an order's
    // lines with it.
    //
    // The extract knows what it read. Every non-PO extractor stamps its own
    // classification ("quote", "invoice", "packing_list", "assembly_bom",
    // "part_drawing", "eway_bill", "ack"), and the PO extractor only ever
    // emits po / rfq / non_po. So a classification outside the PO tool's own
    // enum means this is not a purchase order, whatever the job row claims.
    const PO_CLASSIFICATIONS = new Set(["po", "rfq", "non_po"]);
    const classification = mergedNorm.classification || null;
    const classifiedNonPo = !!classification && !PO_CLASSIFICATIONS.has(classification);
    if (orderId && PO_SHAPED.has(jobKind) && classifiedNonPo) {
      await emit(svc, tenantCtx, "docai_chunk_merged_no_writeback", {
        job_id: job.id, order_id: orderId, kind: jobKind, classification,
        line_count: mergedLines.length,
        detail: "job says '" + jobKind + "' but the document read as '" + classification
          + "' — refusing to write it into the order's lines. Apply migration 219 and re-queue.",
      });
    }
    if (orderId && PO_SHAPED.has(jobKind) && !classifiedNonPo) {
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
