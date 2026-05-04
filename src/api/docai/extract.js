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
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { dispatchExtract } from "../_lib/docai/index.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
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

    const status = !out.ok ? "failed"
      : (out.confidence_overall != null && out.confidence_overall < 0.7 ? "low_confidence" : "ok");

    await svc.from("extraction_runs").update({
      adapter_used: out.adapter_used || null,
      adapter_attempts: out.attempts || [],
      raw_extract: out.raw || null,
      normalized_extract: out.normalized || null,
      field_confidences: out.confidences || {},
      confidence_overall: out.confidence_overall ?? null,
      status,
      error: out.error || null,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    await recordAudit(ctx, {
      action: status === "ok" ? "docai_extract_ok"
        : status === "low_confidence" ? "docai_extract_low_confidence"
        : "docai_extract_failed",
      objectType: "extraction_run",
      objectId: runId,
      detail: (out.adapter_used || "none") + "::" + (out.confidence_overall ?? "n/a"),
    });

    return json(res, 200, {
      run_id: runId,
      status,
      adapter_used: out.adapter_used || null,
      confidence_overall: out.confidence_overall ?? null,
      normalized: out.normalized || null,
      attempts: out.attempts || [],
      error: out.error || null,
    });
  } catch (err) { sendError(res, err); }
}
