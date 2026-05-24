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
import { safeFetch } from "../_lib/safe-fetch.js";

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

    let sourceBytes = body?.bytes_base64
      ? Buffer.from(body.bytes_base64, "base64")
      : null;
    let resolvedUrl = body?.source_url || null;
    let resolvedFilename = body?.source_filename || null;
    let resolvedMime = body?.mime || null;

    // Re-extraction path. The SO workspace's "run extraction" button
    // (and any caller re-running against an already-uploaded PO) ships
    // only { source_id, order_id } -- the file is no longer in the
    // browser, so there are no bytes_base64 to send. Previously the
    // endpoint passed bytes=null straight through, the pipeline never
    // populated bodyText, and the Claude adapter died with the cryptic
    // "needs hints.bodyText, bytes (PDF/image/text), or url". Resolve
    // the storage object server-side instead: it avoids round-tripping
    // a multi-MB PDF through the client and gives every caller (cron
    // rerun, source-PO ack, future correction-driven rerun) the same
    // behaviour. We only do this when nothing else can feed the model.
    const docHandle = body?.document_id || body?.source_id || null;
    if (!sourceBytes && !resolvedUrl && !body?.hints?.bodyText && docHandle) {
      const { data: doc } = await svc.from("documents")
        .select("storage_bucket, storage_path, mime_type, filename")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", docHandle)
        .maybeSingle();
      if (doc?.storage_bucket && doc?.storage_path) {
        resolvedMime = resolvedMime || doc.mime_type || null;
        resolvedFilename = resolvedFilename || doc.filename || null;
        const { data: signed, error: signErr } = await svc.storage
          .from(doc.storage_bucket)
          .createSignedUrl(doc.storage_path, 60 * 5);
        if (!signErr && signed?.signedUrl) {
          try {
            const upstream = await safeFetch(signed.signedUrl);
            if (upstream.ok) {
              sourceBytes = Buffer.from(await upstream.arrayBuffer());
            }
          } catch (_) { /* fall through to the 400 below */ }
        }
      }
    }

    // Fail fast with a clear, operator-actionable error instead of the
    // adapter-level "needs hints.bodyText, bytes, or url" message when
    // we genuinely have nothing to extract from.
    if (!sourceBytes && !resolvedUrl && !body?.hints?.bodyText) {
      return json(res, 400, {
        error: {
          code: "NO_SOURCE_BYTES",
          message: docHandle
            ? "Could not load the source document for extraction. It may have been moved or deleted from storage; re-upload the PO and try again."
            : "Extraction needs a document: attach a PO file, pass source_id, or provide source_url.",
        },
      });
    }

    const sourceType = body?.source_type
      || (resolvedFilename?.toLowerCase().endsWith(".xlsx") ? "xlsx"
          : (resolvedMime?.startsWith("image/") ? "image" : "pdf"));

    const result = await runExtractionPipeline({
      ctx, svc, settings,
      bytes: sourceBytes,
      url: resolvedUrl,
      filename: resolvedFilename,
      mime: resolvedMime,
      sourceType,
      customerId: body?.customer_id || null,
      documentId: body?.document_id || (body?.source_id || null),
      sourceId: body?.source_id || null,
      caseId: body?.order_id || body?.source_id || null,
      kind: body?.kind || "po",
      // Audit fix May 2026: resolveContext returns `user` not
      // `userId`; the original `ctx.userId` was always undefined,
      // so extraction_runs.triggered_by was never populated and the
      // Pipeline Diagnostics tab could not show who ran a job.
      triggeredBy: ctx.user?.id || null,
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
