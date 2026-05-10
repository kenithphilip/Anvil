// GET /api/orders/<id>/pipeline-state
//
// Aggregates everything the workspace's Pipeline Diagnostics tab
// needs to show "what happened to this order's docai pipeline":
//
//   - The order itself (status, preflight_payload, source_document_id)
//   - The source document row (filename, size, mime, scan_status)
//   - The extraction_runs row(s) for the order's source document
//     (status, status_reason, adapter_used, adapter_attempts,
//     normalized_extract preview, raw_extract preview, confidence)
//   - All processing_events keyed to the order_id OR the source_id
//   - The OCR runs (status, page_count, evidence_count, error)
//   - Tenant docai adapter configuration health
//
// This is the SINGLE source of truth the operator can read when
// extraction returned 0 lines or stamped a run_id but produced no
// usable data. Without this they were guessing.
//
// Read-permission: anyone who can view the order.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// Truncate a JSONB blob to a preview-friendly size; keeps the panel
// from blowing up the wire format when raw_extract is huge.
const PREVIEW_BYTES = 12_000;
const previewJson = (obj) => {
  if (!obj) return null;
  const s = JSON.stringify(obj);
  if (s.length <= PREVIEW_BYTES) return obj;
  return { _truncated_at: PREVIEW_BYTES, _preview: s.slice(0, PREVIEW_BYTES) + "...[truncated]" };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    // The dynamic-router strips /api and dispatches by prefix +
    // suffix. The handler reads the order id from req.query.id
    // (set by the dynamic-route helper) or as a fallback parses
    // it out of the URL.
    let orderId = req.query?.id;
    if (!orderId) {
      const m = String(req.url || "").match(/\/orders\/([^/]+)\/pipeline-state/);
      if (m) orderId = m[1];
    }
    if (!orderId) return json(res, 400, { error: { message: "order id required" } });
    const svc = serviceClient();

    // 1. Order with preflight_payload + result.
    const orderResp = await svc.from("orders")
      .select("id, status, customer_id, preflight_payload, result, created_at, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", orderId)
      .single();
    if (orderResp.error || !orderResp.data) {
      return json(res, 404, { error: { message: "Order not found" } });
    }
    const order = orderResp.data;
    const sourceDocId = order.preflight_payload?.source_document_id || null;
    const lines = order.result?.salesOrder?.lineItems || [];

    // 2. Source document.
    let document = null;
    if (sourceDocId) {
      const docResp = await svc.from("documents")
        .select("id, filename, mime_type, size_bytes, scan_status, scan_threats, created_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", sourceDocId)
        .maybeSingle();
      document = docResp.data || null;
    }

    // 3. Extraction runs (most recent first; up to 10 retries).
    // Phase B-F: surface the full set of per-run signals the
    // diagnostics tab renders (text_layer_used, ocr_layer_used,
    // template_used, voter_used, overrides_applied, field_provenance,
    // extraction_kind). validator_issues + validator_summary already
    // came in with Phase A.
    let extractionRuns = [];
    if (sourceDocId) {
      const runsResp = await svc.from("extraction_runs")
        .select(`id, source_id, source_type, source_filename, status, status_reason,
                 adapter_used, adapter_attempts, confidence_overall, error,
                 raw_extract, normalized_extract,
                 validator_issues, validator_summary,
                 text_layer_used, ocr_layer_used, template_used,
                 overrides_applied, field_provenance, voter_lines, voter_used,
                 selected_model, model_selection_reason,
                 extraction_kind,
                 started_at, finished_at`)
        .eq("tenant_id", ctx.tenantId)
        .eq("source_id", sourceDocId)
        .order("started_at", { ascending: false })
        .limit(10);
      extractionRuns = (runsResp.data || []).map((r) => ({
        ...r,
        raw_extract: previewJson(r.raw_extract),
        normalized_extract: previewJson(r.normalized_extract),
      }));
    }

    // 3b. L1 text-layer cache for this document. Phase A: lets the
    // diagnostics tab show "L1 has_text · 4,231 chars · 3 pages" so
    // the operator can see whether the deterministic path ran.
    let textLayer = null;
    if (sourceDocId) {
      const tlResp = await svc.from("extraction_text_layer")
        .select("text_status, page_count, char_count, page_breakdown, extractor, latency_ms, created_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("document_id", sourceDocId)
        .maybeSingle();
      textLayer = tlResp.data || null;
    }

    // 3c. L2 OCR-layer cache. Phase B: image-only PDFs that fed
    // the LLM via OCR show up here so the operator can confirm
    // the OCR fallback ran (and reused cache on retries).
    let ocrLayer = null;
    if (sourceDocId) {
      const ocrLayerResp = await svc.from("extraction_ocr_layer")
        .select("ocr_status, page_count, char_count, page_breakdown, bbox_count, provider, provider_model, latency_ms, created_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("document_id", sourceDocId)
        .maybeSingle();
      ocrLayer = ocrLayerResp.data || null;
    }

    // 4. Processing events (keyed by EITHER order_id OR source_id).
    //    The two-OR pattern catches events emitted before order_id
    //    plumbing landed AND events emitted by the workspace re-run
    //    path.
    let events = [];
    {
      const filterParts = ["case_id.eq." + orderId];
      if (sourceDocId) filterParts.push("case_id.eq." + sourceDocId);
      const eventsResp = await svc.from("processing_events")
        .select("id, event_type, object_type, object_id, case_id, detail, duration_ms, created_at")
        .eq("tenant_id", ctx.tenantId)
        .or(filterParts.join(","))
        .order("created_at", { ascending: false })
        .limit(200);
      events = eventsResp.data || [];
    }

    // 5. OCR runs.
    let ocrRuns = [];
    if (sourceDocId) {
      const ocrResp = await svc.from("ocr_runs")
        .select("id, provider, status, page_count, evidence_count, error, started_at, completed_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("document_id", sourceDocId)
        .order("started_at", { ascending: false })
        .limit(10);
      ocrRuns = ocrResp.data || [];
    }

    // 6. Tenant docai adapter configuration health. We reuse the
    // existing tenant_settings columns to derive which adapters
    // would be tried. This catches the "no adapter configured"
    // root cause before the operator burns more credits.
    const settingsResp = await svc.from("tenant_settings")
      .select("docai_provider_order, anthropic_key_provider, mistral_api_key, reducto_api_key, azure_di_endpoint")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    const settings = settingsResp.data || {};
    const adapterChain = settings.docai_provider_order
      || ["reducto", "azure_di", "unstructured", "claude"];
    // Best-effort surface of whether ENV/secret-side keys are set.
    // This is a probe, not a guarantee: the actual isConfigured
    // check happens server-side in each adapter on every dispatch.
    const adapterHealth = adapterChain.map((name) => ({
      name,
      configured_hint:
        name === "claude"   ? !!process.env.ANTHROPIC_API_KEY :
        name === "reducto"  ? !!settings.reducto_api_key :
        name === "azure_di" ? !!settings.azure_di_endpoint :
        false,
    }));

    return json(res, 200, {
      order: {
        id: order.id,
        status: order.status,
        customer_id: order.customer_id,
        lines_count: lines.length,
        preflight_payload: order.preflight_payload || null,
        created_at: order.created_at,
        updated_at: order.updated_at,
      },
      document,
      extraction_runs: extractionRuns,
      processing_events: events,
      ocr_runs: ocrRuns,
      text_layer: textLayer,
      ocr_layer: ocrLayer,
      adapter_chain: adapterHealth,
      // Convenience: surface the most-recent-run summary so the UI
      // can render "Latest run: empty_lines · adapter=claude · mode=
      // utf8_text_fallback" at the top without walking the array.
      latest_run_summary: extractionRuns[0] ? {
        run_id: extractionRuns[0].id,
        status: extractionRuns[0].status,
        status_reason: extractionRuns[0].status_reason,
        adapter_used: extractionRuns[0].adapter_used,
        confidence_overall: extractionRuns[0].confidence_overall,
        finished_at: extractionRuns[0].finished_at,
        attempts: extractionRuns[0].adapter_attempts,
        validator_summary: extractionRuns[0].validator_summary || null,
        text_layer_used: extractionRuns[0].text_layer_used || false,
        ocr_layer_used: extractionRuns[0].ocr_layer_used || false,
        template_used: extractionRuns[0].template_used || null,
        voter_used: extractionRuns[0].voter_used || false,
        overrides_applied_count: Array.isArray(extractionRuns[0].overrides_applied) ? extractionRuns[0].overrides_applied.length : 0,
        extraction_kind: extractionRuns[0].extraction_kind || "po",
        selected_model: extractionRuns[0].selected_model || null,
        model_selection_reason: extractionRuns[0].model_selection_reason || null,
      } : null,
    });
  } catch (err) { sendError(res, err); }
}
