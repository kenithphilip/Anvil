// POST /api/invoices/extract
//
// Phase F.4 + F.6 (EXTRACTION_PIPELINE_PLAN.md). Runs an inbound
// vendor invoice through the unified extraction pipeline AND, if
// asked, materialises the result into ap_invoices +
// ap_invoice_lines so /api/ap/match can run 3-way against the
// source PO + GRN. Without the materialisation, the extraction
// would sit in extraction_runs.normalized_extract with no path
// to AP match (AP match reads ap_invoice_lines).
//
// Body:
//   {
//     document_id?: uuid,
//     bytes_base64?, source_url?, mime?, filename?,
//     order_id?: uuid,                          // case_id correlation
//     customer_id?: uuid,                       // tenant's vendor record id
//     source_po_id?: uuid,                      // link to a source PO
//     ap_invoice_id?: uuid,                     // append lines to an existing AP invoice
//     create_ap_invoice?: boolean,              // create a new ap_invoices row from the extraction
//     vendor_invoice_number?: string,           // override the extracted PO number when creating
//     vote?: bool, hints?: object
//   }
//
// Returns the extraction summary plus the ap_invoice_id when
// materialisation ran.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { runExtractionPipeline } from "../_lib/docai/run.js";

// Build an ap_invoice_lines insert payload from the canonical
// extraction shape. Returns [] when no usable lines found.
const linesFromExtraction = (tenantId, apInvoiceId, normalized) => {
  const ext = Array.isArray(normalized?.lines) ? normalized.lines : [];
  if (!ext.length) return [];
  const out = [];
  ext.forEach((l, idx) => {
    const qty = Number(l?.quantity ?? 0) || 0;
    const unit = Number(l?.unitPrice ?? 0) || 0;
    if (!qty && !unit && !l?.description && !l?.partNumber) return;
    out.push({
      tenant_id: tenantId,
      ap_invoice_id: apInvoiceId,
      line_no: idx + 1,
      description: l?.description || l?.partNumber || null,
      quantity: qty || 1,
      unit_price: unit || 0,
      extended: Number((qty * unit).toFixed(2)) || 0,
      po_line_ref: l?.partNumber || null,
    });
  });
  return out;
};

// Compute totals from a normalized extraction. Tax aggregation
// uses each line's gst_pct when present; falls back to 0.
const totalsFromExtraction = (normalized) => {
  const ext = Array.isArray(normalized?.lines) ? normalized.lines : [];
  let subtotal = 0;
  let tax = 0;
  for (const l of ext) {
    const qty = Number(l?.quantity ?? 0) || 0;
    const unit = Number(l?.unitPrice ?? 0) || 0;
    const gst = Number(l?.gst_pct ?? 0) || 0;
    const ext2 = qty * unit;
    subtotal += ext2;
    tax += ext2 * (gst / 100);
  }
  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax_total: Number(tax.toFixed(2)),
    grand_total: Number((subtotal + tax).toFixed(2)),
  };
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

    // Phase F.6: optionally materialise into ap_invoices +
    // ap_invoice_lines so AP match can run 3-way against the
    // source PO. We only materialise when the extraction
    // succeeded and the caller asked (create_ap_invoice=true) or
    // is appending to an existing ap_invoice (ap_invoice_id).
    let apInvoiceId = body?.ap_invoice_id || null;
    let materialisedLines = 0;
    if (result.status === "ok" && (body?.create_ap_invoice || apInvoiceId)) {
      try {
        if (!apInvoiceId) {
          // Create a new ap_invoices row from the extraction. The
          // vendor_invoice_number is required + tenant-unique;
          // prefer the explicit override, then the extracted PO
          // number, then a synthetic "EXT-<run-id-suffix>" so the
          // insert never fails on null.
          const extractedPo = result.normalized?.customer?.po_number || null;
          const vendorInvoiceNumber = body.vendor_invoice_number
            || extractedPo
            || ("EXT-" + result.runId.slice(0, 8));
          const totals = totalsFromExtraction(result.normalized);
          const ins = await svc.from("ap_invoices").insert({
            tenant_id: ctx.tenantId,
            vendor_id: body?.customer_id || null,
            vendor_invoice_number: vendorInvoiceNumber,
            invoice_date: result.normalized?.customer?.po_date || null,
            currency: result.normalized?.customer?.currency || "INR",
            subtotal: totals.subtotal,
            tax_total: totals.tax_total,
            grand_total: totals.grand_total,
            source_po_id: body?.source_po_id || null,
            match_status: "pending",
            raw: { extraction_run_id: result.runId },
          }).select("id").single();
          if (!ins.error) apInvoiceId = ins.data.id;
        }
        if (apInvoiceId) {
          // Replace lines: delete any existing then insert fresh.
          // Allows re-extracting an invoice without duplicates.
          await svc.from("ap_invoice_lines")
            .delete().eq("tenant_id", ctx.tenantId).eq("ap_invoice_id", apInvoiceId);
          const lineRows = linesFromExtraction(ctx.tenantId, apInvoiceId, result.normalized);
          if (lineRows.length) {
            await svc.from("ap_invoice_lines").insert(lineRows);
            materialisedLines = lineRows.length;
          }
        }
      } catch (e) {
        // Don't break the response on materialisation failure;
        // surface the error so the caller can retry.
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
          ap_invoice_id: null,
          ap_materialisation_error: String(e?.message || e),
        });
      }
    }

    await recordAudit(ctx, {
      action: "invoice_extracted",
      objectType: "extraction_run",
      objectId: result.runId,
      detail: result.statusReason
        + "::" + (result.adapterUsed || "none")
        + "::ap_invoice=" + (apInvoiceId || "n/a")
        + "::lines=" + materialisedLines,
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
      ap_invoice_id: apInvoiceId,
      ap_lines_materialised: materialisedLines,
    });
  } catch (err) { sendError(res, err); }
}
