// POST /api/docai/correction
// Body: { extraction_run_id, field_path, original_value, corrected_value, reason? }
//
// Records an operator-correction. When 50+ corrections accumulate
// for a (tenant, customer, field), the per-customer prompt-overrides
// bundle on tenant_settings is rebuilt so the next Claude-fallback
// extraction includes those examples as few-shot context. Also
// writes an rlhf_feedback row (surface=intake) so the existing
// reward aggregation picks it up.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { safeFire } from "../_lib/safe-thenable.js";
import { promoteCorrectionIfStable } from "../_lib/docai/overrides.js";

const REBUILD_THRESHOLD = 50;
const MAX_EXAMPLES_PER_FIELD = 5;

const rebuildOverridesForField = async (svc, tenantId, customerId, fieldPath) => {
  const r = await svc.from("extraction_corrections")
    .select("original_value, corrected_value, applied_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("field_path", fieldPath)
    .order("applied_at", { ascending: false })
    .limit(200);
  if (r.error) return;
  const examples = (r.data || [])
    .filter((row) => row.original_value !== null || row.corrected_value !== null)
    .slice(0, MAX_EXAMPLES_PER_FIELD)
    .map((row) => ({
      from: typeof row.original_value === "string" ? row.original_value : JSON.stringify(row.original_value),
      to:   typeof row.corrected_value === "string" ? row.corrected_value : JSON.stringify(row.corrected_value),
    }));
  const settings = await tenantSettings(svc, tenantId);
  const overrides = settings?.docai_prompt_overrides || {};
  const customerOverrides = overrides[customerId] || {};
  customerOverrides[fieldPath] = examples;
  overrides[customerId] = customerOverrides;
  await updateTenantSettings(svc, tenantId, { docai_prompt_overrides: overrides });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.extraction_run_id || !body?.field_path) {
      return json(res, 400, { error: { message: "extraction_run_id and field_path required" } });
    }
    const svc = serviceClient();
    // Look up the run to attach customer + populate the rlhf row.
    const run = await svc.from("extraction_runs")
      .select("id, customer_id")
      .eq("tenant_id", ctx.tenantId).eq("id", body.extraction_run_id).maybeSingle();
    if (run.error) throw new Error(run.error.message);
    if (!run.data) return json(res, 404, { error: { message: "extraction_run not found" } });
    const customerId = body?.customer_id || run.data.customer_id;

    const ins = await svc.from("extraction_corrections").insert({
      tenant_id: ctx.tenantId,
      extraction_run_id: body.extraction_run_id,
      customer_id: customerId,
      field_path: body.field_path,
      original_value: body.original_value ?? null,
      corrected_value: body.corrected_value ?? null,
      reason: body.reason || null,
      user_id: ctx.userId || null,
    }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);

    // RLHF feedback row so the existing aggregator picks this up.
    // safeFire: best-effort, labelled so a failure surfaces in stderr.
    safeFire(svc.from("rlhf_feedback").insert({
      tenant_id: ctx.tenantId,
      surface: "intake",
      case_id: body.extraction_run_id,
      prompt: { extraction_run_id: body.extraction_run_id, field: body.field_path },
      output: { value: body.original_value },
      corrected_output: { value: body.corrected_value },
      rating: -1,
      comment: body.reason || "operator correction",
      user_id: ctx.userId || null,
    }), "rlhf_feedback");

    await recordAudit(ctx, {
      action: "docai_correction",
      objectType: "extraction_run",
      objectId: body.extraction_run_id,
      detail: body.field_path,
    });

    // Rebuild the per-customer Claude few-shot overrides if we
    // crossed the threshold.
    if (customerId) {
      const cnt = await svc.from("extraction_corrections")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", customerId)
        .eq("field_path", body.field_path);
      if ((cnt.count || 0) >= REBUILD_THRESHOLD) {
        await rebuildOverridesForField(svc, ctx.tenantId, customerId, body.field_path);
      }
    }

    // Phase E: promote a stable correction to a customer-field
    // override the moment we see two matching corrections in a
    // row. This means the operator's fix takes effect on the NEXT
    // upload, not after 50 corrections of waiting. ALL adapters
    // benefit, not just Claude few-shot.
    let promoted = null;
    if (customerId) {
      try {
        promoted = await promoteCorrectionIfStable(svc, {
          tenantId: ctx.tenantId,
          customerId,
          fieldPath: body.field_path,
        });
      } catch (_e) { promoted = null; }
    }

    return json(res, 200, { ok: true, id: ins.data.id, override_promoted: promoted });
  } catch (err) { sendError(res, err); }
}
