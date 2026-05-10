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
import { extractTextLayer, contentHash } from "./text_layer.js";
import { extractOcrLayer } from "./ocr_layer.js";
import { applyTemplate, buildTemplate } from "./templates.js";
import { applyOverrides, loadOverrides, recordOverrideUsage } from "./overrides.js";
import { voteAcrossAdapters } from "./voter.js";
import { validateExtraction } from "./validators.js";
import { recordEvent } from "../audit.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_REGEX.test(s);
const safeFire = (p, label) => {
  Promise.resolve(p).catch((err) => {
    /* eslint-disable no-console */
    console.error("[docai/run] " + label + ": " + (err?.message || err));
  });
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

const getOrExtractOcrLayer = async ({ svc, tenantId, documentId, bytes, mime, filename, hash }) => {
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
  const layer = await extractOcrLayer({ buffer: bytes, filename, mimeType: mime });
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
const runAllAdaptersInParallel = async ({ source, settings, customerId, hints }) => {
  const order = settings?.docai_provider_order
    || ["docling", "marker", "unstructured", "reducto", "azure_di", "claude"];
  // Run each candidate as its own dispatch with a single-adapter
  // order. The dispatcher's isConfigured() loop still skips
  // anything missing credentials.
  const promises = order.map(async (adapterName, idx) => {
    const out = await dispatchExtract({
      source,
      settings: { ...settings, docai_provider_order: [adapterName] },
      customerId,
      hints,
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
    sourceType = "pdf", customerId = null, documentId = null,
    sourceId = null, caseId = null, kind = "po",
    triggeredBy = null, inboundEmailId = null,
    vote = false, hints = {}, recordEvents = true,
  } = params;

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

  // 1. Open the extraction_runs row.
  const ins = await svc.from("extraction_runs").insert({
    tenant_id: ctx.tenantId,
    customer_id: customerId,
    source_type: sourceType,
    source_id: sourceId || documentId || null,
    source_url: url || null,
    source_filename: filename,
    source_size_bytes: bytes ? bytes.length : null,
    status: "running",
    triggered_by: triggeredBy,
    inbound_email_id: inboundEmailId,
    extraction_kind: kind,
  }).select("id").single();
  if (ins.error) throw new Error(ins.error.message);
  const runId = ins.data.id;

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
  let contentSha = null;
  if (bytes && (sourceType === "pdf" || mime === "application/pdf")) {
    const got = await getOrExtractTextLayer({ svc, tenantId: ctx.tenantId, documentId, bytes, mime });
    textLayer = got.layer;
    contentSha = got.hash;
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
  } else if (bytes) {
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
    });
    ocrLayer = got.layer;
    if (ocrLayer?.ok && ocrLayer.body_text) {
      bodyText = ocrLayer.body_text;
      ocrLayerUsed = true;
    }
    await recordRunEvent("docai_ocr_layer_extracted", {
      status: ocrLayer?.status,
      char_count: ocrLayer?.char_count,
      page_count: ocrLayer?.page_count,
      bbox_count: ocrLayer?.bbox_count,
      cached: got.cached,
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

  // 5. L4 dispatch.
  const dispatchHints = { ...hints };
  if (bodyText) dispatchHints.bodyText = bodyText;
  if (templateApplied?.used && templateApplied?.normalized?.customer) {
    dispatchHints.knownFields = templateApplied.normalized.customer;
  }
  if (kind && kind !== "po") dispatchHints.expectedKind = kind;

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
    });
    voted = voteAcrossAdapters(all);
    if (voted) {
      out = {
        ok: true,
        adapter_used: "voter",
        normalized: voted.normalized,
        confidences: voted.confidences,
        confidence_overall: voted.confidence_overall,
        attempts: voted.attempts,
        raw: { voter_used: true, per_adapter: all.map((r) => ({
          adapter: r.adapter_used, ok: r.ok, conf: r.confidence_overall,
        })) },
        mode: "voter",
      };
    } else if (all.length === 1) {
      out = all[0];
    } else if (all.length === 0) {
      out = { ok: false, reason: "no_adapter_configured", attempts: [], error: "no docai adapter configured" };
    } else {
      out = all[0];
    }
  } else {
    out = await dispatchExtract({
      source: dispatchSource,
      settings: { ...settings, tenant_id: ctx.tenantId },
      customerId,
      hints: dispatchHints,
    });
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

  // 9. Persist the run.
  await svc.from("extraction_runs").update({
    adapter_used: out?.adapter_used || null,
    adapter_attempts: out?.attempts || [],
    raw_extract: out?.raw || null,
    normalized_extract: out?.normalized || null,
    field_confidences: out?.confidences || {},
    confidence_overall: out?.confidence_overall ?? null,
    status,
    status_reason: statusReason,
    validator_issues: v.issues || [],
    validator_summary: v.summary || {},
    text_layer_used: textLayerUsed,
    ocr_layer_used: ocrLayerUsed,
    template_used: templateApplied?.used ? templateApplied.template_id : null,
    overrides_applied: overridesApplied,
    field_provenance: voted?.field_provenance || [],
    voter_lines: voted?.voter_lines || [],
    voter_used: !!voted,
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
      voter_used: !!voted,
      validator_summary: v.summary || null,
      overrides_applied_count: overridesApplied.length,
      error: out?.error || null,
    },
  );

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
    error: out?.error || null,
  };
};
