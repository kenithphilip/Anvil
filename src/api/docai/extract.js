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
      hints: body?.hints || {},
    });

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
      // Distinguish the three "ok-shaped, no lines" causes:
      //   - the adapter ran in utf-8 fallback on a PDF -> image_pdf_no_text
      //   - the model returned ok with empty lines -> empty_lines
      //   - low confidence -> low_confidence
      const conf = out.confidence_overall;
      if (out.mode === "utf8_text_fallback" && sourceType === "pdf") {
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
      error: out.error || null,
    });
  } catch (err) { sendError(res, err); }
}
