// POST /api/marketplace/report
//   { global_id, reason, evidence? }
//
// Consumer-side abuse report. Reasons are enumerated:
//   mis_extracts_value | exfiltrates_data | pii_leak |
//   redos_pattern | irrelevant_template | other
//
// Three confirmed reports against the same publisher tenant
// auto-suspend the publisher (handled in marketplace.js when the
// super-admin confirms via /review).
//
// RBAC: read+write (any user can report from the consumer UI).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_REASONS = new Set([
  "mis_extracts_value", "exfiltrates_data", "pii_leak",
  "redos_pattern", "irrelevant_template", "other",
]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    if (!body.global_id) {
      return json(res, 400, { error: { message: "global_id required" } });
    }
    if (!VALID_REASONS.has(body.reason)) {
      return json(res, 400, {
        error: { message: "reason must be one of: " + Array.from(VALID_REASONS).join(", ") },
      });
    }
    const svc = serviceClient();
    // Ensure the global template exists.
    const g = await svc.from("customer_format_templates_global")
      .select("id, status, revoke_reports")
      .eq("id", body.global_id).maybeSingle();
    if (g.error) throw new Error(g.error.message);
    if (!g.data) return json(res, 404, { error: { message: "global_not_found" } });

    const ins = await svc.from("template_reports").insert({
      global_id: body.global_id,
      reporter_tenant_id: ctx.tenantId,
      reporter_user_id: ctx.user?.id || null,
      reason: body.reason,
      evidence: body.evidence || {},
    }).select("*").maybeSingle();
    if (ins.error) throw new Error(ins.error.message);

    // Bump report count for visibility (super-admin can sort by this).
    await svc.from("customer_format_templates_global").update({
      revoke_reports: (Number(g.data.revoke_reports) || 0) + 1,
    }).eq("id", body.global_id);

    await recordAudit(ctx, {
      action: "marketplace.report.filed",
      objectType: "template_report",
      objectId: ins.data?.id,
      detail: { global_id: body.global_id, reason: body.reason },
    });
    return json(res, 200, { report: ins.data });
  } catch (err) { sendError(res, err); }
}
