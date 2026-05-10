// POST /api/invoices/extract
//
// Phase F.4 (EXTRACTION_PIPELINE_PLAN.md). Runs an inbound invoice
// (typically a vendor invoice received via email) through the
// unified extraction pipeline so AP can match it 3-way against the
// source PO + GRN. Same flow as the PO extractor; the only change
// is extraction_kind='invoice' which routes Claude to a slightly
// different prompt-emphasis (lines almost always have HSN +
// gst_pct on a vendor invoice).
//
// Body:
//   {
//     document_id?: uuid,
//     bytes_base64?, source_url?, mime?, filename?,
//     order_id?: uuid,                       // for case_id correlation
//     customer_id?: uuid,                    // tenant's vendor record id
//     vote?: bool, hints?: object
//   }
//
// Returns the extraction summary. AP's match endpoint reads
// normalized_extract from extraction_runs to drive the 3-way logic.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { runExtractionPipeline } from "../_lib/docai/run.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);

    const documentId = body?.document_id || null;
    let sourceBytes = null;
    let sourceUrl = body?.source_url || null;
    let mime = body?.mime || null;
    let filename = body?.filename || null;
    let documentRow = null;

    if (documentId) {
      const docResp = await svc.from("documents")
        .select("id, storage_bucket, storage_path, filename, mime_type, scan_status")
        .eq("tenant_id", ctx.tenantId).eq("id", documentId).maybeSingle();
      if (docResp.error || !docResp.data) {
        return json(res, 404, { error: { message: "Document not found" } });
      }
      documentRow = docResp.data;
      if (documentRow.scan_status !== "clean") {
        return json(res, 409, { error: { message: "Document must be scanned-clean before extraction." } });
      }
      filename = filename || documentRow.filename;
      mime = mime || documentRow.mime_type;
      const signed = await svc.storage
        .from(documentRow.storage_bucket)
        .createSignedUrl(documentRow.storage_path, 60 * 5);
      if (!signed.error && signed.data?.signedUrl) {
        sourceUrl = signed.data.signedUrl;
        const dl = await fetch(signed.data.signedUrl);
        if (dl.ok) sourceBytes = Buffer.from(await dl.arrayBuffer());
      }
    } else if (body?.bytes_base64) {
      sourceBytes = Buffer.from(body.bytes_base64, "base64");
    }

    const sourceType = (mime || "").startsWith("image/") ? "image" : "pdf";

    const result = await runExtractionPipeline({
      ctx, svc, settings,
      bytes: sourceBytes,
      url: sourceUrl,
      filename,
      mime,
      sourceType,
      customerId: body?.customer_id || null,
      documentId: documentRow?.id || null,
      sourceId: documentRow?.id || null,
      caseId: body?.order_id || documentRow?.id || null,
      kind: "invoice",
      triggeredBy: ctx.userId || null,
      vote: !!body?.vote,
      hints: { order_id: body?.order_id || null, ...(body?.hints || {}) },
    });

    await recordAudit(ctx, {
      action: "invoice_extracted",
      objectType: "extraction_run",
      objectId: result.runId,
      detail: result.statusReason + "::" + (result.adapterUsed || "none"),
    });

    return json(res, 200, {
      run_id: result.runId,
      status: result.status,
      status_reason: result.statusReason,
      adapter_used: result.adapterUsed,
      confidence_overall: result.confidenceOverall,
      normalized: result.normalized,
      voter_used: result.voterUsed,
      validator_summary: result.validatorSummary,
      validator_issues: result.validatorIssues,
      text_layer_used: result.textLayerUsed,
      ocr_layer_used: result.ocrLayerUsed,
      template_used: result.templateUsed,
    });
  } catch (err) { sendError(res, err); }
}
