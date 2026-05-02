import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const APPROVE_INPUTS = ["status", "approval", "payload_hash", "result", "rule_findings", "anomaly_flags", "evidence_by_field", "line_edits", "blocker_summary", "format_change_summary", "cost_avoided_reason", "api_usage", "token_estimate"];

const buildPatch = (body) => {
  const patch = {};
  for (const key of APPROVE_INPUTS) if (key in body) patch[key] = body[key];
  return patch;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const id = req.query.id || req.url.split("/").pop().split("?")[0];
    if (!id) return json(res, 400, { error: { message: "Order id required" } });
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (error || !data) return json(res, 404, { error: { message: "Order not found" } });
      const findings = await svc.from("validation_findings").select("*").eq("tenant_id", ctx.tenantId).eq("order_id", id);
      const evidence = await svc.from("evidence").select("*").eq("tenant_id", ctx.tenantId).eq("order_id", id);
      const sourcePos = await svc.from("source_pos").select("*").eq("tenant_id", ctx.tenantId).eq("order_id", id);
      return json(res, 200, {
        order: data,
        findings: findings.data || [],
        evidence: evidence.data || [],
        sourcePos: sourcePos.data || [],
      });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const patch = buildPatch(body);
      const { data: prev, error: prevErr } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (prevErr || !prev) return json(res, 404, { error: { message: "Order not found" } });

      const intendedAction = body.intendedAction || (body.status === "APPROVED" ? "approve" : body.status === "EXPORTED_TO_TALLY" ? "export_tally" : null);
      if (prev.approval && prev.approval_expires_at && new Date(prev.approval_expires_at).getTime() < Date.now() && body.status && body.status !== prev.status && intendedAction !== "approve") {
        return json(res, 409, { error: { message: "Approval expired. Re-approve before updating." } });
      }
      if (prev.approval && Array.isArray(prev.approval_actions) && prev.approval_actions.length && intendedAction && !prev.approval_actions.includes(intendedAction) && body.status && body.status !== prev.status) {
        return json(res, 409, { error: { message: "Action '" + intendedAction + "' not in approval allowlist " + prev.approval_actions.join(",") } });
      }

      if (body.status === "APPROVED") {
        if (!body.approval || !body.approval.payloadHash) return json(res, 400, { error: { message: "Approval requires payload hash" } });
        requirePermission(ctx, "approve");
        patch.approval = { ...body.approval, approvedBy: ctx.user ? ctx.user.id : null };
        patch.approved_at = new Date().toISOString();
        patch.approved_by = ctx.user ? ctx.user.id : null;
        const ttlHours = Number(body.approval.ttlHours || 24);
        patch.approval_expires_at = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
        patch.approval_actions = Array.isArray(body.approval.approvedActions) && body.approval.approvedActions.length
          ? body.approval.approvedActions
          : ["approve", "export_tally", "create_source_pos", "send_customer_ack"];
      }
      // Editing a critical field invalidates approval
      const editKeys = ["result", "line_edits"];
      if (editKeys.some((k) => k in body) && prev.approval) {
        patch.approval = null;
        patch.approval_expires_at = null;
        patch.approval_actions = [];
      }

      const { data, error } = await svc.from("orders").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: body.status === "APPROVED" ? "approve_order" : "update_order", objectType: "order", objectId: id, before: prev, after: data, payloadHash: data.payload_hash, reason: body.reason });
      await recordEvent(ctx, { caseId: id, eventType: body.status === "APPROVED" ? "manager_approved" : "order_updated", objectType: "order", objectId: id, detail: { status: data.status, intendedAction } });
      return json(res, 200, { order: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const { data: prev } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      const { error } = await svc.from("orders").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "delete_order", objectType: "order", objectId: id, before: prev || null });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
