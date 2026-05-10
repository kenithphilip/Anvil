// POST /api/source_pos/<id>/ack_extract
//
// Phase F.2 (EXTRACTION_PIPELINE_PLAN.md). Takes a supplier-ack
// PDF (the supplier sent us back a confirmation document) and
// runs it through the unified extraction pipeline with
// extraction_kind='supplier_ack'. Persists the structured result
// into supplier_ack_extractions so the operator can review the
// extracted price + ETA + per-line confirmations before clicking
// Accept (which then forwards into the existing /api/source_pos/ack
// endpoint as a structured payload).
//
// Body:
//   {
//     document_id?: uuid,                     // pre-uploaded document
//     bytes_base64?, source_url?, mime?,      // or inline PDF
//     filename?, vote?: bool, hints?: object
//   }
//
// Returns the extraction summary plus the supplier_ack_extractions
// row id so the workspace can render review state immediately.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { runExtractionPipeline } from "../_lib/docai/run.js";

// Pull /source_pos/<id>/ack_extract out of the URL when the router
// dispatched without setting req.query.id (which can happen if the
// request shape changes; defensive).
const idFromUrl = (req) => {
  const u = String(req.url || "");
  const m = u.match(/\/source_pos\/([^/?]+)\/ack_extract/);
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const sourcePoId = req.query?.id || idFromUrl(req);
    if (!sourcePoId) {
      return json(res, 400, { error: { message: "source_po id required in URL" } });
    }
    const svc = serviceClient();

    // Verify the source PO exists + belongs to this tenant.
    const spo = await svc.from("source_pos")
      .select("id, status, supplier, total_foreign, currency")
      .eq("tenant_id", ctx.tenantId).eq("id", sourcePoId).maybeSingle();
    if (spo.error) throw new Error(spo.error.message);
    if (!spo.data) return json(res, 404, { error: { message: "Source PO not found" } });

    const body = await readBody(req);
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
      // Sign + download so the L1/L2 layers can run.
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
      customerId: null,                               // suppliers, not customers
      documentId: documentRow?.id || null,
      sourceId: documentRow?.id || null,
      caseId: sourcePoId,
      kind: "supplier_ack",
      triggeredBy: ctx.userId || null,
      vote: !!body?.vote,
      hints: { source_po_id: sourcePoId, ...(body?.hints || {}) },
    });

    // Pull the supplier_ack header out of the raw response (Claude
    // adapter parks it on raw.supplier_ack), or from
    // normalized.supplier_ack as a fallback.
    const ackHeader = result.normalized?.supplier_ack
      || result.normalized?.customer
      || null;

    const lineAcks = (result.normalized?.lines || []).map((l) => ({
      partNumber: l?.partNumber || null,
      quantity: l?.quantity ?? null,
      unit_price: l?.unitPrice ?? null,
      eta: l?.eta || null,
      rejected: l?.rejected ?? null,
    }));

    // Persist a supplier_ack_extractions review row. The operator
    // confirms the values, then commits via /api/source_pos/ack
    // which writes the canonical fields onto source_pos.
    const ins = await svc.from("supplier_ack_extractions").insert({
      tenant_id: ctx.tenantId,
      source_po_id: sourcePoId,
      extraction_run_id: result.runId,
      document_id: documentRow?.id || null,
      supplier_ref: ackHeader?.supplier_ref || null,
      confirmed_price: ackHeader?.confirmed_price ?? null,
      confirmed_currency: ackHeader?.confirmed_currency || null,
      confirmed_eta: ackHeader?.confirmed_eta || null,
      payment_terms: ackHeader?.payment_terms || null,
      remarks: ackHeader?.remarks || null,
      line_acks: lineAcks,
      status: "extracted",
    }).select("*").single();
    if (ins.error) throw new Error(ins.error.message);

    await recordAudit(ctx, {
      action: "supplier_ack_extracted",
      objectType: "source_po",
      objectId: sourcePoId,
      detail: result.statusReason + "::" + (result.adapterUsed || "none"),
    });
    await recordEvent(ctx, {
      eventType: "supplier_ack_extracted",
      objectType: "source_po",
      objectId: sourcePoId,
      caseId: sourcePoId,
      detail: {
        run_id: result.runId,
        adapter_used: result.adapterUsed,
        status_reason: result.statusReason,
        confirmed_price: ackHeader?.confirmed_price ?? null,
        confirmed_eta: ackHeader?.confirmed_eta || null,
        line_count: lineAcks.length,
      },
    });

    return json(res, 200, {
      supplier_ack_extraction: ins.data,
      run_id: result.runId,
      status: result.status,
      status_reason: result.statusReason,
      adapter_used: result.adapterUsed,
      confidence_overall: result.confidenceOverall,
      voter_used: result.voterUsed,
      validator_summary: result.validatorSummary,
      validator_issues: result.validatorIssues,
    });
  } catch (err) { sendError(res, err); }
}
