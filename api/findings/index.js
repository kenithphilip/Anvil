import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const findings = (body.findings || []).map((f) => ({
        tenant_id: ctx.tenantId,
        order_id: body.order_id,
        rule_id: f.ruleId || f.rule_id || "unknown",
        code: f.code,
        severity: f.severity || "WARNING",
        owner: f.owner || null,
        blocks: !!f.blocks,
        line_index: f.lineIndex != null ? f.lineIndex : f.line_index,
        detail: f.detail || null,
        suggested_fix: f.suggestedFix || f.suggested_fix || null,
      })).filter((row) => row.code && row.order_id);
      if (!findings.length) return json(res, 200, { ok: true, count: 0 });
      const { error } = await svc.from("validation_findings").insert(findings);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true, count: findings.length });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("validation_findings").update({
        resolved: !!body.resolved,
        resolved_at: body.resolved ? new Date().toISOString() : null,
        resolved_by: ctx.user ? ctx.user.id : null,
      }).eq("tenant_id", ctx.tenantId).eq("id", body.id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
