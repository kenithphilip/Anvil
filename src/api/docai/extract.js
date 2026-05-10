// POST /api/docai/extract
// Body: {
//   source_type?: 'pdf'|'xlsx'|'scan'|'email_attachment'|'image',
//   source_id?: string, source_url?: string, source_filename?: string,
//   bytes_base64?: string, mime?: string,
//   customer_id?: uuid, hints?: object,
//   inbound_email_id?: uuid
// }
//
// Runs Document AI v2 against the requested document. Picks an
// adapter from the tenant's docai_provider_order, falls back on
// failure or low-confidence, persists to extraction_runs.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { dispatchExtract } from "../_lib/docai/index.js";
import { extractTextLayer, contentHash } from "../_lib/docai/text_layer.js";
import { validateExtraction } from "../_lib/docai/validators.js";

// Phase A: L1 text-layer cache helpers. Pure local helpers; the
// dispatcher stays DB-free so it remains test-friendly.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_REGEX.test(s);

// Look up + on-miss insert + return the text layer for a (tenant,
// document_id || content_hash). Best-effort: if any DB call fails,
// we still return the freshly-extracted result so extraction
// proceeds. Cache misses are silent.
const getOrExtractTextLayer = async ({ svc, tenantId, documentId, bytes, mime }) => {
  // The hash is the cross-shape cache key (works for both
  // document-bound and inline-attachment paths).
  const hash = await contentHash(bytes).catch(() => null);
  // 1) Lookup
  try {
    if (documentId && isUuid(documentId)) {
      const r = await svc.from("extraction_text_layer")
        .select("*").eq("tenant_id", tenantId).eq("document_id", documentId)
        .maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data), cached: true, hash };
    }
    if (hash) {
      const r = await svc.from("extraction_text_layer")
        .select("*").eq("tenant_id", tenantId).eq("content_hash", hash)
        .is("document_id", null).maybeSingle();
      if (r?.data) return { layer: rowToLayer(r.data), cached: true, hash };
    }
  } catch (_e) { /* fall through to fresh extract */ }
  // 2) Extract
  const layer = await extractTextLayer({ bytes, mime });
  // 3) Persist (best-effort; ignore failures)
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
    // Use upsert with the appropriate constraint depending on the
    // shape we're persisting.
    if (insert.document_id) {
      await svc.from("extraction_text_layer").upsert(insert, { onConflict: "tenant_id,document_id" });
    } else if (insert.content_hash) {
      await svc.from("extraction_text_layer").upsert(insert, { onConflict: "tenant_id,content_hash" });
    }
  } catch (_e) { /* swallow */ }
  return { layer, cached: false, hash };
};

const rowToLayer = (row) => ({
  ok: row.text_status !== "image_only" && row.text_status !== "extract_failed",
  status: row.text_status,
  page_count: row.page_count,
  char_count: row.char_count,
  body_text: row.body_text,
  page_breakdown: row.page_breakdown || [],
  extractor: row.extractor,
  extractor_version: row.extractor_version,
  latency_ms: row.latency_ms,
  error: null,
});

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    // Read-side operation in practice: the caller (so-intake's auto-
    // extract on PO upload) just needs the structured extraction so
    // they can match-or-prefill the customer dialog. Was "approve"
    // which locked sales engineers out of the intake flow with an
    // opaque 403. Falls back to "write" so anyone who can create a
    // sales order can also auto-extract.
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);

    const sourceType = body?.source_type
      || (body?.source_filename?.toLowerCase().endsWith(".xlsx") ? "xlsx"
          : (body?.mime?.startsWith("image/") ? "image" : "pdf"));

    // Open the run row first so we have a stable id to attach
    // attempts to.
    const ins = await svc.from("extraction_runs").insert({
      tenant_id: ctx.tenantId,
      customer_id: body?.customer_id || null,
      source_type: sourceType,
      source_id: body?.source_id || null,
      source_url: body?.source_url || null,
      source_filename: body?.source_filename || null,
      source_size_bytes: body?.size_bytes || null,
      status: "running",
      triggered_by: ctx.userId || null,
      inbound_email_id: body?.inbound_email_id || null,
    }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    const runId = ins.data.id;

    const sourceBytes = body?.bytes_base64
      ? Buffer.from(body.bytes_base64, "base64")
      : null;

    // Phase 3.6 observability (audit close): emit "started" event so
    // operators see the run begin even if the dispatcher hangs. Keyed
    // by BOTH order_id (when supplied) and source_id so the workspace
    // Activity stream picks it up regardless of which the workspace
    // queries by. The previous code keyed only by source_id which the
    // workspace never read.
    const caseId = body?.order_id || body?.source_id || null;
    await recordEvent(ctx, {
      eventType: "docai_extract_started",
      objectType: "extraction_run",
      objectId: runId,
      caseId,
      detail: {
        source_type: sourceType,
        source_id: body?.source_id || null,
        order_id: body?.order_id || null,
        size_bytes: body?.size_bytes || null,
        mime: body?.mime || null,
      },
    });

    // Phase A (EXTRACTION_PIPELINE_PLAN.md): L1 deterministic text
    // extraction. Runs before the LLM dispatcher; if the PDF has a
    // text layer with >= 200 chars we feed it to the adapters as
    // hints.bodyText so claude.js sends pre_extracted_text instead of
    // a base64 PDF. Cuts cost ~50% and eliminates the
    // image_pdf_no_text failure mode for any PDF that has any
    // usable text layer.
    let textLayer = null;
    let textLayerUsed = false;
    if (sourceBytes && (sourceType === "pdf" || body?.mime === "application/pdf")) {
      const documentId = body?.document_id || body?.source_id || null;
      try {
        const got = await getOrExtractTextLayer({
          svc, tenantId: ctx.tenantId, documentId, bytes: sourceBytes, mime: body?.mime,
        });
        textLayer = got.layer;
        await recordEvent(ctx, {
          eventType: "docai_text_layer_extracted",
          objectType: "extraction_run",
          objectId: runId,
          caseId,
          detail: {
            status: textLayer.status,
            page_count: textLayer.page_count,
            char_count: textLayer.char_count,
            cached: got.cached,
            extractor: textLayer.extractor,
            latency_ms: textLayer.latency_ms,
          },
        });
      } catch (_e) {
        // Fail-soft: missing unpdf or unexpected PDF should not break
        // the LLM dispatch path.
        textLayer = null;
      }
    }

    const incomingHints = body?.hints || {};
    let dispatchHints = incomingHints;
    if (textLayer?.ok && textLayer.body_text && !incomingHints.bodyText) {
      dispatchHints = { ...incomingHints, bodyText: textLayer.body_text };
      textLayerUsed = true;
    }

    const out = await dispatchExtract({
      source: {
        url: body?.source_url || null,
        bytes: sourceBytes,
        filename: body?.source_filename || null,
        mime: body?.mime || null,
        sourceType,
      },
      settings: { ...settings, tenant_id: ctx.tenantId },
      customerId: body?.customer_id,
      hints: dispatchHints,
    });

    // Phase A: L5 validators. Run domain rules over the normalized
    // result; downgrade confidence on errors / 3+ warnings so the
    // dispatcher's 0.7 threshold catches malformed extractions
    // before they reach reconciliation. Pure: no I/O.
    const v = validateExtraction(out?.normalized || null, {
      currentConfidence: out?.confidence_overall,
    });
    if (v.adjustedConfidence != null && v.adjustedConfidence !== out.confidence_overall) {
      out.confidence_overall = v.adjustedConfidence;
    }

    // Phase 3.6: derive a structured status_reason. The dispatcher /
    // adapters now return `reason` so we don't have to guess.
    //   ok           ok with lines + confidence >= 0.7
    //   low_confidence  ok-shaped but conf < 0.7
    //   empty_lines  ok with 0 lines (model couldn't pull lines)
    //   non_po       classifier said "this isn't a PO"
    //   image_pdf_no_text  utf-8 fallback on a binary PDF
    //   no_adapter_configured / all_adapters_skipped
    //   parse_failed / model_refused / upstream_error
    //   fail_unknown for catch-all
    const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : [];
    let statusReason;
    let status;
    if (!out.ok) {
      status = "failed";
      statusReason = out.reason || "fail_unknown";
    } else if (out.normalized?.classification === "non_po") {
      status = "failed";
      statusReason = "non_po";
    } else if (lines.length === 0) {
      // Distinguish the four "ok-shaped, no lines" causes:
      //   - L1 detected an image-only PDF -> image_pdf_no_text
      //     (pre-empts the utf-8 fallback path; surfaces before the
      //     LLM ever runs).
      //   - the adapter ran in utf-8 fallback on a PDF -> image_pdf_no_text
      //   - the model returned ok with empty lines -> empty_lines
      //   - low confidence -> low_confidence
      const conf = out.confidence_overall;
      if (textLayer?.status === "image_only" && sourceType === "pdf") {
        status = "failed";
        statusReason = "image_pdf_no_text";
      } else if (out.mode === "utf8_text_fallback" && sourceType === "pdf") {
        status = "failed";
        statusReason = "image_pdf_no_text";
      } else if (conf != null && conf < 0.7) {
        status = "low_confidence";
        statusReason = "low_confidence";
      } else {
        status = "failed";
        statusReason = "empty_lines";
      }
    } else if (out.confidence_overall != null && out.confidence_overall < 0.7) {
      status = "low_confidence";
      statusReason = "low_confidence";
    } else {
      status = "ok";
      statusReason = "ok";
    }

    await svc.from("extraction_runs").update({
      adapter_used: out.adapter_used || null,
      adapter_attempts: out.attempts || [],
      raw_extract: out.raw || null,
      normalized_extract: out.normalized || null,
      field_confidences: out.confidences || {},
      confidence_overall: out.confidence_overall ?? null,
      status,
      status_reason: statusReason,
      validator_issues: v.issues || [],
      validator_summary: v.summary || {},
      text_layer_used: textLayerUsed,
      error: out.error || null,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    await recordAudit(ctx, {
      action: status === "ok" ? "docai_extract_ok"
        : status === "low_confidence" ? "docai_extract_low_confidence"
        : "docai_extract_failed",
      objectType: "extraction_run",
      objectId: runId,
      detail: (out.adapter_used || "none") + "::" + (out.confidence_overall ?? "n/a") + "::" + statusReason,
    });

    // Phase 3.6: emit a step-boundary event for EVERY outcome (not
    // just failures), with the structured reason. The workspace's
    // Pipeline Diagnostics tab reads these via `events.list(orderId)`
    // and renders the chain.
    await recordEvent(ctx, {
      eventType: status === "ok" ? "docai_extract_succeeded"
        : status === "low_confidence" ? "docai_extract_low_confidence"
        : "docai_extract_failed",
      objectType: "extraction_run",
      objectId: runId,
      caseId,
      detail: {
        adapter_used: out.adapter_used || null,
        adapter_mode: out.mode || null,
        confidence_overall: out.confidence_overall ?? null,
        status_reason: statusReason,
        lines_count: lines.length,
        attempts: out.attempts || [],
        text_layer_used: textLayerUsed,
        text_layer_status: textLayer?.status || null,
        validator_summary: v.summary || null,
        error: out.error || null,
      },
    });

    return json(res, 200, {
      run_id: runId,
      status,
      status_reason: statusReason,
      adapter_used: out.adapter_used || null,
      adapter_mode: out.mode || null,
      confidence_overall: out.confidence_overall ?? null,
      normalized: out.normalized || null,
      attempts: out.attempts || [],
      text_layer: textLayer
        ? {
            status: textLayer.status,
            char_count: textLayer.char_count,
            page_count: textLayer.page_count,
            used: textLayerUsed,
          }
        : null,
      validator_issues: v.issues || [],
      validator_summary: v.summary || null,
      error: out.error || null,
    });
  } catch (err) { sendError(res, err); }
}
