// Unified extraction pipeline.
//
// Phases A-E wired in execution order. Every consumer (SO intake,
// auto_ocr cron, source PO ack, invoice match, e-Way bill) calls
// runExtractionPipeline() so they all benefit from:
//
//   L0  file gate                 (existing scan_status check by caller)
//   L1  deterministic text layer  (text_layer.js)        Phase A
//   L2  OCR fallback              (ocr_layer.js)         Phase B
//   L3  customer format template  (templates.js)         Phase D
//   L4  LLM dispatcher            (index.js, voter.js)   Phase C
//   L5  shared validators         (validators.js)        Phase A
//   L6  cross-adapter voter       (voter.js)             Phase C
//   E   field overrides applied   (overrides.js)         Phase E
//
// The pipeline:
//
//   1. Open extraction_runs row (status=running, kind=...).
//   2. Compute content_hash; lookup or insert extraction_text_layer.
//      If the layer pulled >= 200 chars of text, hold it as
//      `bodyText`. Skip L2.
//   3. If bodyText is empty AND we have bytes, run L2 OCR; cache
//      result in extraction_ocr_layer; use OCR-derived bodyText.
//   4. If we know the customer, look up their active template and
//      try to fill known fields deterministically.
//   5. Decide L4 strategy based on `vote` flag:
//        - false  -> serial dispatch (existing behaviour)
//        - true   -> run every configured adapter in parallel,
//                    then voter.voteAcrossAdapters() reduces.
//      In both modes, hints.bodyText is set to the L1/L2 text + any
//      template-known fields are passed via hints.knownFields.
//   6. After dispatch, apply customer field overrides (Phase E).
//   7. Run L5 validators; downgrade confidence on issues.
//   8. Persist + emit events.
//   9. If status=ok and customer_id is set, run buildTemplate()
//      asynchronously: it's cheap, idempotent, and bumps the
//      template if we've crossed the 3-run threshold.
//
// Returns:
//   { runId, status, statusReason, normalized, confidenceOverall,
//     adapterUsed, attempts, textLayer, ocrLayer, templateUsed,
//     overridesApplied, validatorIssues, validatorSummary,
//     fieldProvenance, voterUsed, error }

import { dispatchExtract } from "./index.js";
import { chunkedExtract } from "./chunked-extract.js";
import { profileDocument } from "./toc-profiler.js";
import { probePdfPageCount } from "./pdf-chunker.js";
import { extractTextLayer, contentHash } from "./text_layer.js";
import { extractOcrLayer } from "./ocr_layer.js";
import { applyTemplate, buildTemplate } from "./templates.js";
import { createRunCostAccumulator } from "./run-cost.js";
import { buildCustomerHints } from "./customer-hints.js";
import { prepareEmailBody } from "./email-body.js";
// Bet 2: format-template marketplace L3.5 hook.
import {
  findGlobalCandidates, applyGlobalTemplate, shouldPromoteToSkipLlm,
  __consts as marketplaceConsts,
} from "./marketplace.js";
import { applyOverrides, loadOverrides, recordOverrideUsage } from "./overrides.js";
import { voteAcrossAdapters } from "./voter.js";
import { validateExtraction } from "./validators.js";
import { recordEvent } from "../audit.js";
import { buildTenantIdentity, scrubCustomerOfTenantIdentity } from "./tenant-scrub.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_REGEX.test(s);
const safeFire = (p, label) => {
  Promise.resolve(p).catch((err) => {
    /* eslint-disable no-console */
    console.error("[docai/run] " + label + ": " + (err?.message || err));
  });
};

// Wave 1.3 / Improvement #12. Default 30 minute window before a
// re-upload triggers a fresh extraction. Operators sometimes re-
// upload a PO twice within a few seconds while debugging an intake
// flow, and the batch importer retries failed cron iterations; both
// land here. Tenants can tune the window via
// settings.docai_content_dedupe_minutes (0 = disabled, max 1440).
const DEFAULT_DEDUPE_MINUTES = 30;

const resolveDedupeMinutes = (settings) => {
  const raw = settings?.docai_content_dedupe_minutes;
  if (raw === 0 || raw === "0") return 0;             // explicit opt-out
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DEDUPE_MINUTES;
  if (n < 0) return 0;
  if (n > 1440) return 1440;                          // 24h hard cap
  return n;
};

// Look up the most-recent successful extraction_runs row with the
// same content_hash + tenant + customer + extraction_kind within
// the dedupe window. Returns null when nothing qualifies (the
// dispatcher then runs the full pipeline). The query is keyed on
// the partial index added by migration 118.
const findRecentRunByContentHash = async ({
  svc, tenantId, customerId, kind, hash, minutes,
}) => {
  if (!svc || !tenantId || !hash || !minutes) return null;
  try {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    let q = svc.from("extraction_runs")
      .select("id,normalized_extract,raw_extract,field_confidences,confidence_overall,status,status_reason,adapter_used,adapter_attempts,validator_issues,validator_summary,text_layer_used,ocr_layer_used,template_used,global_template_used,global_template_use_mode,overrides_applied,field_provenance,voter_used,selected_model,model_selection_reason,parse_method,parse_repairs,parse_retries,created_at")
      .eq("tenant_id", tenantId)
      .eq("content_hash", hash)
      .eq("extraction_kind", kind)
      .eq("status", "ok")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    // customer scope: an SO with a known customer must NOT dedupe
    // against a run that had no customer (the overrides + template
    // path differs). The reverse also holds.
    q = customerId ? q.eq("customer_id", customerId) : q.is("customer_id", null);
    const r = await q.maybeSingle();
    return r?.data || null;
  } catch (_e) {
    return null;
  }
};

// Cache miss + insert for the L1 text layer. Mirrors the helper
// the legacy extract.js had; moved here so all callers share it.
const getOrExtractTextLayer = async ({ svc, tenantId, documentId, bytes, mime }) => {
  if (!bytes) return { layer: null, cached: false, hash: null };
  const hash = await contentHash(bytes).catch(() => null);
  try {
    if (documentId && isUuid(documentId)) {
      const r = await svc.from("extraction_text_layer")
        .select("*").eq("tenant_id", tenantId).eq("document_id", documentId).maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data, "text"), cached: true, hash };
    }
    if (hash) {
      const r = await svc.from("extraction_text_layer")
        .select("*").eq("tenant_id", tenantId).eq("content_hash", hash)
        .is("document_id", null).maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data, "text"), cached: true, hash };
    }
  } catch (_e) { /* fall through */ }
  const layer = await extractTextLayer({ bytes, mime });
  try {
    const insert = {
      tenant_id: tenantId,
      document_id: documentId && isUuid(documentId) ? documentId : null,
      content_hash: hash,
      text_status: layer.status,
      page_count: layer.page_count,
      char_count: layer.char_count,
      body_text: layer.body_text,
      page_breakdown: layer.page_breakdown,
      extractor: layer.extractor,
      extractor_version: layer.extractor_version,
      latency_ms: layer.latency_ms,
    };
    if (insert.document_id) {
      await svc.from("extraction_text_layer").upsert(insert, { onConflict: "tenant_id,document_id" });
    } else if (insert.content_hash) {
      await svc.from("extraction_text_layer").upsert(insert, { onConflict: "tenant_id,content_hash" });
    }
  } catch (_e) { /* swallow */ }
  return { layer, cached: false, hash };
};

const getOrExtractOcrLayer = async ({ svc, tenantId, documentId, bytes, mime, filename, hash, settings }) => {
  if (!bytes) return { layer: null, cached: false };
  try {
    if (documentId && isUuid(documentId)) {
      const r = await svc.from("extraction_ocr_layer")
        .select("*").eq("tenant_id", tenantId).eq("document_id", documentId).maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data, "ocr"), cached: true };
    }
    if (hash) {
      const r = await svc.from("extraction_ocr_layer")
        .select("*").eq("tenant_id", tenantId).eq("content_hash", hash)
        .is("document_id", null).maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data, "ocr"), cached: true };
    }
  } catch (_e) { /* fall through */ }
  // Bet 1: route through the Mistral OCR 3 batch endpoint when the
  // tenant opted in (default true). 50% cheaper at the cost of
  // batched (non-realtime) responses; for SO intake, the user is
  // already waiting on multi-second extraction so the latency
  // delta is invisible.
  const ocrOpts = {
    batch: settings?.docai_mistral_ocr_batch !== false,
  };
  const layer = await extractOcrLayer({ buffer: bytes, filename, mimeType: mime, opts: ocrOpts });
  try {
    const insert = {
      tenant_id: tenantId,
      document_id: documentId && isUuid(documentId) ? documentId : null,
      content_hash: hash,
      ocr_status: layer.status,
      page_count: layer.page_count,
      char_count: layer.char_count,
      body_text: layer.body_text,
      page_breakdown: layer.page_breakdown,
      bbox_count: layer.bbox_count,
      provider: layer.provider,
      provider_model: layer.provider_model,
      latency_ms: layer.latency_ms,
      raw_meta: { error: layer.error || null },
    };
    if (insert.document_id) {
      await svc.from("extraction_ocr_layer").upsert(insert, { onConflict: "tenant_id,document_id" });
    } else if (insert.content_hash) {
      await svc.from("extraction_ocr_layer").upsert(insert, { onConflict: "tenant_id,content_hash" });
    }
  } catch (_e) { /* swallow */ }
  return { layer, cached: false };
};

const rowToLayer = (row, kind) => ({
  ok: kind === "text" ? (row.text_status === "has_text" || row.text_status === "mixed")
                       : (row.ocr_status === "ok" || row.ocr_status === "partial"),
  status: kind === "text" ? row.text_status : row.ocr_status,
  page_count: row.page_count,
  char_count: row.char_count,
  body_text: row.body_text,
  page_breakdown: row.page_breakdown || [],
  bbox_count: row.bbox_count || 0,
  extractor: row.extractor,
  provider: row.provider,
  provider_model: row.provider_model,
  latency_ms: row.latency_ms,
  error: null,
});

// Run every configured adapter in parallel, return their results
// in dispatcher-order so the voter can break ties by rank. We
// reuse dispatchExtract by running it multiple times with
// single-adapter orders and stitching the results together. This
// keeps the per-adapter retry, cache-control, and prompt-overrides
// logic in one place.
const runAllAdaptersInParallel = async ({ source, settings, customerId, hints, runCost = null }) => {
  const order = settings?.docai_provider_order
    || ["docling", "marker", "unstructured", "reducto", "azure_di", "claude"];
  // Run each candidate as its own dispatch with a single-adapter
  // order. The dispatcher's isConfigured() loop still skips
  // anything missing credentials.
  // Note: voter mode races every adapter at once, so the per-run
  // cost accumulator does NOT short-circuit in-flight calls; it
  // only adjusts the running total as each parallel call lands.
  // Voter mode is opt-in and rare; the per-day cost guard plus
  // the cap on overall extractions per tenant is the safety net.
  const promises = order.map(async (adapterName, idx) => {
    const out = await dispatchExtract({
      source,
      settings: { ...settings, docai_provider_order: [adapterName] },
      customerId,
      hints,
      runCost,
    });
    if (!out.adapter_used) return null;     // skipped (not configured)
    return { ...out, _rank: idx };
  });
  const results = await Promise.all(promises);
  return results.filter(Boolean);
};

// Top-level runner. Caller supplies:
//   ctx        { tenantId, userId, user? }
//   svc        supabase client
//   settings   tenant_settings row
//   bytes?     Buffer
//   url?       signed URL fallback (used when bytes are unavailable)
//   filename?
//   mime?
//   sourceType 'pdf' | 'image' | ...
//   customerId
//   documentId (UUID FK to documents; optional)
//   sourceId   text key used by extraction_runs.source_id (defaults to documentId)
//   caseId     events.case_id (order_id, source_po_id, invoice_id, ...)
//   kind       extraction_runs.extraction_kind
//   triggeredBy auth.users.id
//   inboundEmailId? for inbound-email runs
//   vote       boolean: run all adapters in parallel + vote
//   hints      extra hints to merge in
//   recordEvents whether to write processing_events (default true)
export const runExtractionPipeline = async (params) => {
  const {
    ctx, svc, settings,
    bytes = null, url = null, filename = null, mime = null,
    sourceType: sourceTypeParam = "pdf", customerId = null, documentId = null,
    sourceId = null, caseId = null, kind = "po",
    triggeredBy = null, inboundEmailId = null,
    vote = false, hints = {}, recordEvents = true,
    // Wave 2.3: email body inputs. When the caller has an inbound
    // email with no PDF attachment but a PO-shaped body, pass
    // emailBody={body_text, body_html} and the pipeline skips L1/L2
    // and routes the cleaned text directly to L4.
    emailBody = null,
  } = params;
  let sourceType = sourceTypeParam;

  const recordRunEvent = (eventType, detail) => {
    if (!recordEvents) return Promise.resolve();
    return recordEvent(ctx, {
      eventType,
      objectType: "extraction_run",
      objectId: runId,
      caseId,
      detail,
    }).catch((err) => {
      /* eslint-disable no-console */
      console.error("[docai/run] event " + eventType + ": " + (err?.message || err));
    });
  };

  // Wave 1.3: hash the input bytes early so we can short-circuit
  // a re-upload before paying for the LLM call. Falls through to
  // the full pipeline on any failure (missing bytes, hash error,
  // dedupe disabled by tenant, no prior run within the window).
  let preHash = null;
  if (bytes && bytes.length) {
    try { preHash = await contentHash(bytes); } catch (_e) { preHash = null; }
  }
  const dedupeMinutes = resolveDedupeMinutes(settings);
  let dedupeSource = null;
  if (preHash && dedupeMinutes > 0) {
    dedupeSource = await findRecentRunByContentHash({
      svc, tenantId: ctx.tenantId, customerId, kind, hash: preHash, minutes: dedupeMinutes,
    });
  }

  // 1. Open the extraction_runs row.
  const ins = await svc.from("extraction_runs").insert({
    tenant_id: ctx.tenantId,
    customer_id: customerId,
    source_type: sourceType,
    source_id: sourceId || documentId || null,
    source_url: url || null,
    source_filename: filename,
    source_size_bytes: bytes ? bytes.length : null,
    content_hash: preHash,
    status: "running",
    triggered_by: triggeredBy,
    inbound_email_id: inboundEmailId,
    extraction_kind: kind,
  }).select("id").single();
  if (ins.error) throw new Error(ins.error.message);
  const runId = ins.data.id;

  // Dedupe short-circuit. Stamp the run row with the prior result
  // and return BEFORE we open the text layer / OCR / LLM chain.
  // The caller still gets a fresh runId so downstream wiring
  // (extraction_run_id on orders, audit trail) continues to work.
  if (dedupeSource) {
    const prior = dedupeSource;
    const finishedAt = new Date().toISOString();
    await svc.from("extraction_runs").update({
      adapter_used: prior.adapter_used || null,
      adapter_attempts: prior.adapter_attempts || [],
      raw_extract: prior.raw_extract || null,
      normalized_extract: prior.normalized_extract || null,
      field_confidences: prior.field_confidences || {},
      confidence_overall: prior.confidence_overall ?? null,
      status: "ok",
      status_reason: "dedupe_hit",
      validator_issues: prior.validator_issues || [],
      validator_summary: prior.validator_summary || {},
      text_layer_used: !!prior.text_layer_used,
      ocr_layer_used: !!prior.ocr_layer_used,
      template_used: prior.template_used || null,
      global_template_used: prior.global_template_used || null,
      global_template_use_mode: prior.global_template_use_mode || null,
      overrides_applied: prior.overrides_applied || [],
      field_provenance: prior.field_provenance || [],
      voter_used: !!prior.voter_used,
      selected_model: prior.selected_model || null,
      model_selection_reason: prior.model_selection_reason || "dedupe_hit",
      parse_method: prior.parse_method || null,
      parse_repairs: prior.parse_repairs || [],
      parse_retries: prior.parse_retries || 0,
      error: null,
      finished_at: finishedAt,
    }).eq("id", runId);
    await recordRunEvent("docai_extract_deduped", {
      prior_run_id: prior.id,
      content_hash: preHash,
      window_minutes: dedupeMinutes,
      adapter_used: prior.adapter_used || null,
      confidence_overall: prior.confidence_overall ?? null,
    });
    return {
      runId,
      status: "ok",
      statusReason: "dedupe_hit",
      normalized: prior.normalized_extract || null,
      confidenceOverall: prior.confidence_overall ?? null,
      adapterUsed: prior.adapter_used || null,
      adapterMode: "dedupe_hit",
      attempts: prior.adapter_attempts || [],
      textLayer: null,
      textLayerUsed: !!prior.text_layer_used,
      ocrLayer: null,
      ocrLayerUsed: !!prior.ocr_layer_used,
      templateUsed: prior.template_used || null,
      templateHits: 0,
      overridesApplied: prior.overrides_applied || [],
      validatorIssues: prior.validator_issues || [],
      validatorSummary: prior.validator_summary || null,
      fieldProvenance: prior.field_provenance || [],
      voterUsed: !!prior.voter_used,
      selectedModel: prior.selected_model || null,
      modelSelectionReason: prior.model_selection_reason || "dedupe_hit",
      parseMethod: prior.parse_method || null,
      parseRepairs: prior.parse_repairs || [],
      parseRetries: prior.parse_retries || 0,
      dedupeOf: prior.id,
      error: null,
    };
  }

  await recordRunEvent("docai_extract_started", {
    source_type: sourceType,
    document_id: documentId,
    customer_id: customerId,
    kind,
    voter: vote,
    has_bytes: !!bytes,
  });

  // 2. L1 text layer.
  let textLayer = null;
  let textLayerUsed = false;
  let bodyText = hints.bodyText || null;
  let contentSha = preHash;
  // Wave 2.3: email-body short-circuit. When the caller provides
  // emailBody (no PDF attachment, body itself is the PO), the
  // prepared body becomes bodyText and L1/L2 are skipped entirely
  // because there is no PDF / image to extract. sourceType flips
  // to "email" so the downstream chunker's PDF-only path doesn't
  // fire.
  let emailBodyPrepared = null;
  if (!bodyText && emailBody && (emailBody.body_text || emailBody.body_html)) {
    emailBodyPrepared = prepareEmailBody({
      body_text: emailBody.body_text,
      body_html: emailBody.body_html,
      opts: emailBody.opts || {},
    });
    if (emailBodyPrepared.ok && emailBodyPrepared.body_text) {
      bodyText = emailBodyPrepared.body_text;
      sourceType = "email";
      await recordRunEvent("docai_email_body_extracted", {
        source: emailBodyPrepared.source,
        original_chars: emailBodyPrepared.original_chars,
        cleaned_chars: emailBodyPrepared.cleaned_chars,
        po_likeness: emailBodyPrepared.po_likeness,
        trimmed_signature: emailBodyPrepared.trimmed_signature,
      });
    } else {
      await recordRunEvent("docai_email_body_rejected", {
        source: emailBodyPrepared.source,
        po_likeness: emailBodyPrepared.po_likeness,
        reason: emailBodyPrepared.reason,
      });
    }
  }
  if (bytes && (sourceType === "pdf" || mime === "application/pdf")) {
    const got = await getOrExtractTextLayer({ svc, tenantId: ctx.tenantId, documentId, bytes, mime });
    textLayer = got.layer;
    contentSha = got.hash || preHash;
    if (!bodyText && textLayer?.ok && textLayer.body_text) {
      bodyText = textLayer.body_text;
      textLayerUsed = true;
    }
    await recordRunEvent("docai_text_layer_extracted", {
      status: textLayer?.status,
      char_count: textLayer?.char_count,
      page_count: textLayer?.page_count,
      cached: got.cached,
    });
  } else if (bytes && !contentSha) {
    contentSha = await contentHash(bytes).catch(() => null);
  }

  // 3. L2 OCR fallback for image-only PDFs (and image MIME types).
  let ocrLayer = null;
  let ocrLayerUsed = false;
  const wantsOcr = !bodyText && bytes && (
    (sourceType === "pdf" && (textLayer?.status === "image_only" || textLayer?.status === "extract_failed"))
    || sourceType === "image" || (mime || "").startsWith("image/")
  );
  if (wantsOcr) {
    const got = await getOrExtractOcrLayer({
      svc, tenantId: ctx.tenantId, documentId, bytes, mime, filename, hash: contentSha,
      settings,
    });
    ocrLayer = got.layer;
    if (ocrLayer?.ok && ocrLayer.body_text) {
      bodyText = ocrLayer.body_text;
      ocrLayerUsed = true;
    }
    // Phase E3: surface low-confidence OCR pages so operators
    // can spot a scanned-page miss before it pollutes the
    // extraction. lowConfidencePages returns pages whose
    // chars-weighted block confidence is below the threshold
    // (default 0.65, tunable per tenant via
    // settings.docai_ocr_min_confidence).
    let lowConfPages = [];
    try {
      const { lowConfidencePages } = await import("./ocr_layer.js");
      const threshold = Number.isFinite(Number(settings?.docai_ocr_min_confidence))
        ? Number(settings.docai_ocr_min_confidence)
        : 0.65;
      lowConfPages = lowConfidencePages(ocrLayer?.page_breakdown || [], threshold);
    } catch (_e) { /* swallow; this is observability only */ }
    await recordRunEvent("docai_ocr_layer_extracted", {
      status: ocrLayer?.status,
      char_count: ocrLayer?.char_count,
      page_count: ocrLayer?.page_count,
      bbox_count: ocrLayer?.bbox_count,
      cached: got.cached,
      low_confidence_page_count: lowConfPages.length,
      low_confidence_pages: lowConfPages.slice(0, 30), // cap to keep payload small
    });
  }

  // 4. L3 template apply (only when we know the customer + have body text).
  let templateApplied = null;
  if (customerId && bodyText) {
    try {
      templateApplied = await applyTemplate(svc, {
        tenantId: ctx.tenantId, customerId, kind, bodyText,
      });
    } catch (_e) { templateApplied = null; }
    if (templateApplied?.used) {
      await recordRunEvent("docai_template_applied", {
        template_id: templateApplied.template_id,
        hits: templateApplied.hits,
        misses: templateApplied.misses,
      });
    }
  }

  // 4.5. L3.5: global format-template marketplace (Bet 2).
  // Only fires when L3 missed (tenant doesn't have a local template
  // for this customer yet) AND consumer opt-in is true. Defaults
  // to HINT MODE; promotion to skip_llm requires N operator-
  // confirmed imports.
  let globalApplied = null;
  if (
    !templateApplied?.used
    && bodyText
    && settings?.template_marketplace_consumer_optin !== false
  ) {
    try {
      const localFp = hints?.fingerprint || {};
      const candidates = await findGlobalCandidates(svc, {
        kind, localFingerprint: localFp, bodyText,
      });
      const best = candidates[0];
      if (best && best.score >= marketplaceConsts.HINT_SILENT_THRESHOLD) {
        const promote = best.score >= marketplaceConsts.HINT_THRESHOLD
          && await shouldPromoteToSkipLlm(svc, {
              tenantId: ctx.tenantId,
              globalId: best.global_id,
              threshold: settings?.template_marketplace_skip_llm_after_n_imports,
            });
        const useMode = promote ? "skip_llm" : "hint";
        const applied = await applyGlobalTemplate(svc, ctx, {
          globalId: best.global_id,
          customerId,
          bodyText,
          score: best.score,
          fingerprint_score: best.fingerprint_score,
          anchor_hit_rate: best.anchor_hit_rate,
          useMode,
        });
        if (applied.used) {
          globalApplied = applied;
          await recordRunEvent("docai_global_template_applied", {
            global_id: best.global_id,
            use_mode: useMode,
            score: best.score,
            fingerprint_score: best.fingerprint_score,
            anchor_hit_rate: best.anchor_hit_rate,
          });
        }
      }
    } catch (err) {
      /* eslint-disable no-console */
      console.error("[docai/run] global template apply: " + (err?.message || err));
    }
  }

  // 5. L4 dispatch.
  // Wave 1.4: one cost accumulator per pipeline run, threaded down
  // through chunkedExtract -> dispatchExtract -> per-adapter loop.
  // The hard cap is per-tenant via
  // settings.docai_per_extraction_cost_cap_usd (default $1.00,
  // ceiling $50). When the next adapter call would breach the cap,
  // the dispatcher skips it with status='skipped_over_run_budget'
  // and the chunker breaks circuit on the remaining chunks.
  const runCost = createRunCostAccumulator(settings?.docai_per_extraction_cost_cap_usd);
  await recordRunEvent("docai_run_cost_started", { cap_usd: runCost.cap });

  // Wave 1.5: customer-hint priming. Pulls identity + recent line
  // patterns + a small sample of customer-part -> canonical
  // mappings; the adapters embed the rendered block in the system
  // prompt so the model gets a head start. Best-effort: no hint
  // if no customer, no signal, or query failures. Cached per
  // (tenant_id, customer_id) for 15 minutes inside the module.
  let customerHint = null;
  if (customerId && settings?.docai_customer_hint_priming !== false) {
    try {
      customerHint = await buildCustomerHints(svc, { tenantId: ctx.tenantId, customerId });
      if (customerHint?.rendered) {
        await recordRunEvent("docai_customer_hint_primed", {
          customer_id: customerId,
          has_identity: !!customerHint.identity,
          line_count_sample: customerHint.line_patterns?.line_count_sample || 0,
          top_hsn_count: customerHint.line_patterns?.top_hsn?.length || 0,
          item_mappings_sample_count: customerHint.item_mappings_sample?.length || 0,
        });
      }
    } catch (_e) { customerHint = null; }
  }

  const dispatchHints = { ...hints };
  if (customerHint?.rendered) {
    dispatchHints.customerHint = customerHint;
  }
  if (bodyText) dispatchHints.bodyText = bodyText;
  if (templateApplied?.used && templateApplied?.normalized?.customer) {
    dispatchHints.knownFields = templateApplied.normalized.customer;
  } else if (globalApplied?.used && globalApplied?.normalized?.customer) {
    // L3.5 hint-mode injection: pass the global template's
    // known-fields to L4 as hints. The LLM still runs unless
    // the use_mode is skip_llm (operator already promoted this
    // global template).
    dispatchHints.knownFields = globalApplied.normalized.customer;
    dispatchHints.globalTemplate = {
      id: globalApplied.global_id,
      use_mode: globalApplied.use_mode,
    };
  }
  if (kind && kind !== "po") dispatchHints.expectedKind = kind;
  // Phase Cost-Opt: pass extraction-context summaries so the
  // model selector inside claude.js / gemini.js can pick the
  // right tier deterministically (long doc -> Sonnet, OCR-fed
  // text -> Sonnet, short clean PO -> Haiku/Flash).
  if (textLayer) {
    dispatchHints.textLayer = {
      status: textLayer.status,
      char_count: Number(textLayer.char_count || 0),
      page_count: Number(textLayer.page_count || 0),
    };
  }
  if (ocrLayer) {
    dispatchHints.ocrLayer = {
      status: ocrLayer.status,
      char_count: Number(ocrLayer.char_count || 0),
      page_count: Number(ocrLayer.page_count || 0),
    };
  }

  const dispatchSource = {
    url, bytes, filename, mime, sourceType,
  };
  let out;
  let voted = null;
  if (vote) {
    const all = await runAllAdaptersInParallel({
      source: dispatchSource,
      settings: { ...settings, tenant_id: ctx.tenantId },
      customerId,
      hints: dispatchHints,
      runCost,
    });
    voted = voteAcrossAdapters(all);
    if (voted) {
      // Bet 4: roll up parse_method/parse_repairs/parse_retries
      // from the per-adapter results. parse_method is the worst
      // of the winning ones (so a single sap_zod_retry across a
      // 3-adapter vote surfaces), parse_repairs is the union, and
      // parse_retries is the max.
      const okEntries = all.filter((r) => r && r.ok);
      const methodOrder = ["native_structured", "tool_use", "sap_repaired", "sap_zod_retry", "failed"];
      const worstMethod = okEntries.length
        ? methodOrder.find((m) => okEntries.some((r) => r.parse_method === m)) || "native_structured"
        : "failed";
      const unionRepairs = Array.from(new Set(
        okEntries.flatMap((r) => Array.isArray(r.parse_repairs) ? r.parse_repairs : []),
      ));
      const maxRetries = okEntries.reduce((m, r) => Math.max(m, Number(r.parse_retries) || 0), 0);
      out = {
        ok: true,
        adapter_used: "voter",
        normalized: voted.normalized,
        confidences: voted.confidences,
        confidence_overall: voted.confidence_overall,
        attempts: voted.attempts,
        raw: { voter_used: true, per_adapter: all.map((r) => ({
          adapter: r.adapter_used, ok: r.ok, conf: r.confidence_overall,
          parse_method: r.parse_method || null,
        })) },
        mode: "voter",
        parse_method: worstMethod,
        parse_repairs: unionRepairs,
        parse_retries: maxRetries,
      };
    } else if (all.length === 1) {
      out = all[0];
    } else if (all.length === 0) {
      out = { ok: false, reason: "no_adapter_configured", attempts: [], error: "no docai adapter configured" };
    } else {
      out = all[0];
    }
  } else {
    // Phase A2 + A4: route through chunkedExtract so a multi-page
    // PDF gets split before the LLM call. When the document is
    // large enough to benefit (~> profilerThreshold pages) we
    // first run the TOC profiler (cheap preflight-tier Claude
    // call) to identify the line-item pages so the extractor
    // skips T&C boilerplate. Short PDFs and non-PDFs stay on the
    // single-shot path.
    const chunkEventSink = (e) => {
      recordRunEvent("docai_chunk_" + e.stage, e);
    };
    // Profiler kicks in above this page count. Below it, the
    // extractor reads every page; the cost of one bonus LLM
    // round-trip to triage isn't worth it on a 5-page PO.
    const PROFILER_PAGE_THRESHOLD = 10;
    let keepPages = hints.keepPages || null;
    let profileResult = null;
    const isPdf = (sourceType === "pdf" || mime === "application/pdf");
    if (isPdf && bytes && !keepPages) {
      let totalPages = 0;
      try { totalPages = await probePdfPageCount(bytes); } catch (_e) { /* probe failed; skip profiling */ }
      if (totalPages >= PROFILER_PAGE_THRESHOLD) {
        await recordRunEvent("docai_profiler_started", { page_count: totalPages });
        profileResult = await profileDocument({
          source: { bytes, mime: mime || "application/pdf" },
          tenantId: ctx.tenantId,
          svc,
        }).catch((err) => {
          /* eslint-disable no-console */
          console.warn("[docai/run] profiler threw: " + (err?.message || err));
          return { ok: false, error: err?.message || String(err), line_item_pages: [], confidence: 0 };
        });
        await recordRunEvent("docai_profiler_done", {
          ok: !!profileResult?.ok,
          classification: profileResult?.classification || null,
          confidence: profileResult?.confidence || 0,
          page_count: profileResult?.page_count || totalPages,
          line_item_pages: profileResult?.line_item_pages || [],
          reason: profileResult?.reason || null,
        });
        // Adopt the page-keep list only when the profiler is
        // confident and found at least one line-item page. A
        // failed or low-confidence profile means: just extract
        // every page and pay the cost.
        if (profileResult?.ok && profileResult.line_item_pages?.length) {
          keepPages = profileResult.line_item_pages;
        }
      }
    }
    out = await chunkedExtract({
      source: dispatchSource,
      settings: { ...settings, tenant_id: ctx.tenantId },
      customerId,
      hints: dispatchHints,
      runCost,
      opts: {
        eventSink: chunkEventSink,
        keepPages,
      },
    });
    // Stash the profiler outcome on the extraction result so
    // downstream consumers (UI, audit) can see what was kept and
    // what was skipped.
    if (profileResult) {
      out.toc_profile = {
        classification: profileResult.classification,
        confidence: profileResult.confidence,
        line_item_pages: profileResult.line_item_pages,
        page_count: profileResult.page_count,
        reason: profileResult.reason,
        used: !!keepPages,
      };
    }
  }

  // Merge template-extracted fields into the dispatcher result if
  // the LLM didn't fill them. Template confidence dominates because
  // anchor-based extraction is operator-confirmed.
  if (templateApplied?.used && out?.ok && out.normalized) {
    if (!out.normalized.customer) out.normalized.customer = {};
    for (const [k, v] of Object.entries(templateApplied.normalized.customer || {})) {
      if (out.normalized.customer[k] == null || out.normalized.customer[k] === "") {
        out.normalized.customer[k] = v;
      }
    }
    out.confidences = { ...(out.confidences || {}) };
    for (const [fp, conf] of Object.entries(templateApplied.confidences || {})) {
      if (out.confidences[fp] == null || out.confidences[fp] < conf) out.confidences[fp] = conf;
    }
  }

  // 6. Phase E: apply customer field overrides.
  let overridesApplied = [];
  if (customerId && out?.normalized) {
    try {
      const overrides = await loadOverrides(svc, { tenantId: ctx.tenantId, customerId });
      const applied = applyOverrides(out.normalized, overrides);
      out.normalized = applied.normalized;
      overridesApplied = applied.applied;
      if (overridesApplied.length) {
        // Bump confidence floor for overridden fields.
        out.confidences = { ...(out.confidences || {}) };
        for (const a of overridesApplied) {
          const cur = Number(out.confidences[a.field_path] || 0);
          if (cur < a.confidence_floor) out.confidences[a.field_path] = a.confidence_floor;
        }
        safeFire(recordOverrideUsage(svc, overridesApplied), "recordOverrideUsage");
        await recordRunEvent("docai_overrides_applied", {
          count: overridesApplied.length,
          fields: overridesApplied.map((a) => a.field_path),
        });
      }
    } catch (_e) { /* don't break the run */ }
  }

  // 6b. Tenant-identity scrub (May 2026 audit fix). Strip any
  // customer fields that match the tenant's own contact info.
  // Closes the "extractor pulled the seller's salesperson email
  // into the customer record" leak on Indian POs whose buyer
  // block omits an email but the document body carries the
  // seller's printed contact details.
  let tenantScrubbed = [];
  if (out?.normalized?.customer) {
    try {
      const tQ = await svc.from("tenants")
        .select("display_name")
        .eq("id", ctx.tenantId)
        .maybeSingle();
      const identity = buildTenantIdentity(tQ?.data || null, settings);
      if (identity) {
        const { customer, scrubbed } = scrubCustomerOfTenantIdentity(out.normalized.customer, identity);
        out.normalized.customer = customer;
        tenantScrubbed = scrubbed;
        if (scrubbed.length) {
          await recordRunEvent("docai_tenant_identity_scrubbed", {
            fields: scrubbed,
          });
        }
      }
    } catch (_e) { /* scrub is best-effort */ }
  }

  // 7. L5 validators.
  const v = validateExtraction(out?.normalized || null, {
    currentConfidence: out?.confidence_overall,
  });
  if (v.adjustedConfidence != null && v.adjustedConfidence !== out?.confidence_overall) {
    if (out) out.confidence_overall = v.adjustedConfidence;
  }

  // 8. Derive status_reason.
  const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : [];
  let status;
  let statusReason;
  if (!out || !out.ok) {
    status = "failed";
    statusReason = out?.reason || "fail_unknown";
  } else if (out.normalized?.classification === "non_po" && kind === "po") {
    status = "failed";
    statusReason = "non_po";
  } else if (out.normalized?.classification === "non_ack" && kind === "supplier_ack") {
    // Phase F.2: the supplier-ack classifier rejected the document
    // (it was a marketing brochure, an unrelated PO, etc.). Surface
    // it explicitly instead of silently recording status_reason='ok'.
    status = "failed";
    statusReason = "non_ack";
  } else if (lines.length === 0 && (kind === "po" || kind === "rfq")) {
    const conf = out.confidence_overall;
    if (textLayer?.status === "image_only" && !ocrLayerUsed) {
      status = "failed"; statusReason = "image_pdf_no_text";
    } else if (out.mode === "utf8_text_fallback" && sourceType === "pdf") {
      status = "failed"; statusReason = "image_pdf_no_text";
    } else if (conf != null && conf < 0.7) {
      status = "low_confidence"; statusReason = "low_confidence";
    } else {
      status = "failed"; statusReason = "empty_lines";
    }
  } else if (out.confidence_overall != null && out.confidence_overall < 0.7) {
    status = "low_confidence"; statusReason = "low_confidence";
  } else {
    status = "ok"; statusReason = "ok";
  }

  // 9. Persist the run. selected_model + model_selection_reason
  // come from claude.js / gemini.js's deterministic selector
  // (Phase Cost-Opt). When the voter mode reduced multiple
  // adapters, the per-adapter selection is on raw.per_adapter so
  // we record the voter's "voter" string here.
  // Bet 4: parse_method/parse_repairs/parse_retries describe
  // which JSON-decode path the adapter took. When the run failed
  // outright we still record parse_method='failed' so the
  // diagnostics tab can chart the parse_failed rate over time.
  const parseMethod = status === "failed" && (statusReason === "parse_failed" || statusReason === "fail_unknown")
    ? "failed"
    : (out?.parse_method || null);
  const parseRepairs = Array.isArray(out?.parse_repairs) ? out.parse_repairs : [];
  const parseRetries = Number(out?.parse_retries) || 0;

  // Wave 1.4: persist the per-run cost ledger for the audit trail
  // and the diagnostics tab. Captured even on failure (operator
  // can see which adapters consumed budget before the run gave up).
  const costSummary = runCost.summary();

  await svc.from("extraction_runs").update({
    adapter_used: out?.adapter_used || null,
    adapter_attempts: out?.attempts || [],
    raw_extract: out?.raw || null,
    normalized_extract: out?.normalized || null,
    field_confidences: out?.confidences || {},
    confidence_overall: out?.confidence_overall ?? null,
    cost_summary: costSummary,
    status,
    status_reason: statusReason,
    validator_issues: v.issues || [],
    validator_summary: v.summary || {},
    text_layer_used: textLayerUsed,
    ocr_layer_used: ocrLayerUsed,
    template_used: templateApplied?.used ? templateApplied.template_id : null,
    global_template_used: globalApplied?.used ? globalApplied.global_id : null,
    global_template_use_mode: globalApplied?.used ? globalApplied.use_mode : null,
    overrides_applied: overridesApplied,
    field_provenance: voted?.field_provenance || [],
    voter_lines: voted?.voter_lines || [],
    voter_used: !!voted,
    selected_model: out?.selected_model || (voted ? "voter" : null),
    model_selection_reason: out?.model_selection_reason || (voted ? "voter_aggregate" : null),
    parse_method: parseMethod,
    parse_repairs: parseRepairs,
    parse_retries: parseRetries,
    error: out?.error || null,
    finished_at: new Date().toISOString(),
  }).eq("id", runId);

  await recordRunEvent(
    status === "ok" ? "docai_extract_succeeded"
      : status === "low_confidence" ? "docai_extract_low_confidence"
      : "docai_extract_failed",
    {
      adapter_used: out?.adapter_used || null,
      adapter_mode: out?.mode || null,
      confidence_overall: out?.confidence_overall ?? null,
      status_reason: statusReason,
      lines_count: lines.length,
      attempts: out?.attempts || [],
      text_layer_used: textLayerUsed,
      ocr_layer_used: ocrLayerUsed,
      template_used: !!templateApplied?.used,
      global_template_used: globalApplied?.global_id || null,
      global_template_use_mode: globalApplied?.use_mode || null,
      voter_used: !!voted,
      validator_summary: v.summary || null,
      overrides_applied_count: overridesApplied.length,
      parse_method: parseMethod,
      parse_retries: parseRetries,
      parse_repairs: parseRepairs,
      cost_summary: costSummary,
      error: out?.error || null,
    },
  );

  if (costSummary.breached) {
    await recordRunEvent("docai_run_cost_breached", {
      cap_usd: costSummary.cap_usd,
      total_usd: costSummary.total_usd,
      call_count: costSummary.call_count,
      skipped_count: costSummary.skipped_count,
    });
  }

  // 10. Best-effort: rebuild the customer template after a clean
  // run so the next upload benefits.
  if (status === "ok" && customerId) {
    safeFire(buildTemplate(svc, { tenantId: ctx.tenantId, customerId, kind }), "buildTemplate");
  }

  return {
    runId,
    status,
    statusReason,
    normalized: out?.normalized || null,
    confidenceOverall: out?.confidence_overall ?? null,
    adapterUsed: out?.adapter_used || null,
    adapterMode: out?.mode || null,
    attempts: out?.attempts || [],
    textLayer,
    textLayerUsed,
    ocrLayer,
    ocrLayerUsed,
    templateUsed: templateApplied?.used ? templateApplied.template_id : null,
    templateHits: templateApplied?.hits || 0,
    overridesApplied,
    validatorIssues: v.issues || [],
    validatorSummary: v.summary || null,
    fieldProvenance: voted?.field_provenance || [],
    voterUsed: !!voted,
    selectedModel: out?.selected_model || (voted ? "voter" : null),
    modelSelectionReason: out?.model_selection_reason || (voted ? "voter_aggregate" : null),
    parseMethod,
    parseRepairs,
    parseRetries,
    costSummary,
    error: out?.error || null,
  };
};
