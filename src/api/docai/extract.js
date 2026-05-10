// POST /api/docai/extract
//
// Body: {
//   source_type?: 'pdf'|'xlsx'|'scan'|'email_attachment'|'image',
//   source_id?: string, source_url?: string, source_filename?: string,
//   bytes_base64?: string, mime?: string,
//   document_id?: uuid, customer_id?: uuid, hints?: object,
//   inbound_email_id?: uuid, order_id?: uuid,
//   kind?: 'po'|'rfq'|'supplier_ack'|'invoice'|'eway_bill',
//   vote?: boolean
// }
//
// Runs the unified Phase A+B+C+D+E extraction pipeline. The
// thinness of this handler is deliberate: every consumer of
// extraction (so-intake, auto_ocr cron, source PO ack, invoice
// match, e-Way bill) calls runExtractionPipeline so the layers
// stay in lockstep.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { runExtractionPipeline } from "../_lib/docai/run.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    // Read-side operation in practice: the caller (so-intake's auto-
    // extract on PO upload) just needs the structured extraction so
    // they can match-or-prefill the customer dialog.
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);

    const sourceType = body?.source_type
      || (body?.source_filename?.toLowerCase().endsWith(".xlsx") ? "xlsx"
          : (body?.mime?.startsWith("image/") ? "image" : "pdf"));

    const sourceBytes = body?.bytes_base64
      ? Buffer.from(body.bytes_base64, "base64")
      : null;

    const result = await runExtractionPipeline({
      ctx, svc, settings,
      bytes: sourceBytes,
      url: body?.source_url || null,
      filename: body?.source_filename || null,
      mime: body?.mime || null,
      sourceType,
      customerId: body?.customer_id || null,
      documentId: body?.document_id || (body?.source_id || null),
      sourceId: body?.source_id || null,
      caseId: body?.order_id || body?.source_id || null,
      kind: body?.kind || "po",
      triggeredBy: ctx.userId || null,
      inboundEmailId: body?.inbound_email_id || null,
      vote: !!body?.vote,
      hints: body?.hints || {},
    });

    await recordAudit(ctx, {
      action: result.status === "ok" ? "docai_extract_ok"
        : result.status === "low_confidence" ? "docai_extract_low_confidence"
        : "docai_extract_failed",
      objectType: "extraction_run",
      objectId: result.runId,
      detail: (result.adapterUsed || "none")
        + "::" + (result.confidenceOverall ?? "n/a")
        + "::" + result.statusReason,
    });

    return json(res, 200, {
      run_id: result.runId,
      status: result.status,
      status_reason: result.statusReason,
      adapter_used: result.adapterUsed,
      adapter_mode: result.adapterMode,
      confidence_overall: result.confidenceOverall,
      normalized: result.normalized,
      attempts: result.attempts,
      text_layer: result.textLayer
        ? {
            status: result.textLayer.status,
            char_count: result.textLayer.char_count,
            page_count: result.textLayer.page_count,
            used: result.textLayerUsed,
          }
        : null,
      ocr_layer: result.ocrLayer
        ? {
            status: result.ocrLayer.status,
            char_count: result.ocrLayer.char_count,
            page_count: result.ocrLayer.page_count,
            bbox_count: result.ocrLayer.bbox_count,
            used: result.ocrLayerUsed,
          }
        : null,
      template_used: result.templateUsed,
      overrides_applied: result.overridesApplied,
      field_provenance: result.fieldProvenance,
      voter_used: result.voterUsed,
      selected_model: result.selectedModel,
      model_selection_reason: result.modelSelectionReason,
      validator_issues: result.validatorIssues,
      validator_summary: result.validatorSummary,
      error: result.error,
    });
  } catch (err) { sendError(res, err); }
}
