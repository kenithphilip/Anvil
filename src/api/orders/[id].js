import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { evaluateApprovalsForOrder } from "../_lib/approval-evaluator.js";

const APPROVE_INPUTS = [
  "status", "approval", "payload_hash", "result",
  "rule_findings", "anomaly_flags", "evidence_by_field", "line_edits",
  "blocker_summary", "format_change_summary", "cost_avoided_reason",
  "api_usage", "token_estimate",
  // Corpus-derived columns (migration 006).
  "order_mode", "parent_order_id", "contract_id", "customer_location_id",
  "forward_fx_rate", "forward_contract_ref", "internal_so_type", "project_phase",
  "lost_reason", "competitor_name",
  // Return-for-correction columns (migration 104). Manager-initiated
  // exit path that flips status to DRAFT with a free-text note.
  "correction_reason", "correction_requested_by", "correction_requested_at",
];

const buildPatch = (body) => {
  const patch = {};
  for (const key of APPROVE_INPUTS) if (key in body) patch[key] = body[key];
  return patch;
};

// Audit P1.5 (May 2026). Order status transitions used to be
// completely unguarded: any role with WRITE permission could PATCH
// status from DRAFT directly to EXPORTED_TO_TALLY (skipping
// PENDING_REVIEW + APPROVED) because the only guards were
// conditioned on prev.approval being truthy. With this table the
// PATCH refuses any transition not listed below.
//
// Same-state transitions ("DRAFT -> DRAFT") are allowed so a PATCH
// that doesn't touch status is unaffected. The APPROVED transition
// keeps the existing payload-hash + approve-permission gate.
const ALLOWED_TRANSITIONS = {
  DRAFT:               new Set(["DRAFT", "PENDING_REVIEW", "BLOCKED", "DUPLICATE", "REUSED", "CANCELLED"]),
  PENDING_REVIEW:      new Set(["PENDING_REVIEW", "APPROVED", "BLOCKED", "CANCELLED", "DRAFT"]),
  APPROVED:            new Set(["APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "CANCELLED", "DRAFT"]),
  EXPORTED_TO_TALLY:   new Set(["EXPORTED_TO_TALLY", "RECONCILED", "FAILED_TALLY_IMPORT"]),
  FAILED_TALLY_IMPORT: new Set(["FAILED_TALLY_IMPORT", "EXPORTED_TO_TALLY", "CANCELLED", "APPROVED"]),
  RECONCILED:          new Set(["RECONCILED", "CANCELLED"]),
  CANCELLED:           new Set(["CANCELLED"]),
  BLOCKED:             new Set(["BLOCKED", "DRAFT", "PENDING_REVIEW", "CANCELLED"]),
  DUPLICATE:           new Set(["DUPLICATE", "CANCELLED", "DRAFT"]),
  REUSED:              new Set(["REUSED", "CANCELLED", "DRAFT"]),
};

const isTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  return !!(allowed && allowed.has(to));
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

      // Audit P1.5 (May 2026): block transitions that skip the
      // approval flow. Without this, a DRAFT could PATCH directly
      // to EXPORTED_TO_TALLY because the existing approval-
      // expiry guard only fires when prev.approval already exists.
      if (body.status && body.status !== prev.status && !isTransitionAllowed(prev.status, body.status)) {
        return json(res, 409, {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "Cannot move order from " + prev.status + " to " + body.status + " directly. See ALLOWED_TRANSITIONS in src/api/orders/[id].js.",
            from: prev.status,
            to: body.status,
          },
        });
      }

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
      // Return-for-correction audit shape (migration 104). When the
      // manager flips status to DRAFT with a correction_reason, log a
      // distinct action so the Activity tab + ThreadDrawer can render
      // the manager's note next to the operator's edits.
      const isReturnForCorrection =
        body.status === "DRAFT" &&
        prev.status !== "DRAFT" &&
        typeof body.correction_reason === "string" &&
        body.correction_reason.trim().length > 0;
      const auditAction = isReturnForCorrection
        ? "manager_requested_correction"
        : (body.status === "APPROVED" ? "approve_order" : "update_order");
      await recordAudit(ctx, { action: auditAction, objectType: "order", objectId: id, before: prev, after: data, payloadHash: data.payload_hash, reason: body.reason || (isReturnForCorrection ? body.correction_reason : undefined) });
      await recordEvent(ctx, { caseId: id, eventType: isReturnForCorrection ? "correction_requested" : (body.status === "APPROVED" ? "manager_approved" : "order_updated"), objectType: "order", objectId: id, detail: { status: data.status, intendedAction, correctionReason: isReturnForCorrection ? body.correction_reason : undefined } });

      // Audit P2.6: when an order enters PENDING_REVIEW, evaluate
      // the tenant's quote_approval_thresholds and create the
      // matching pending quote_approvals rows. The thresholds had
      // been a configuration table with no evaluator since
      // migration 006; this closes the loop. Best-effort: failures
      // here log but do not abort the user-visible PATCH.
      let approvalsCreated = null;
      if (body.status === "PENDING_REVIEW" && prev.status !== "PENDING_REVIEW") {
        const ev = await evaluateApprovalsForOrder(svc, ctx.tenantId, data);
        approvalsCreated = ev.created || [];
        if (ev.error) {
          // eslint-disable-next-line no-console
          console.warn("[orders/[id]] approval evaluator failed: " + ev.error);
        }
        if (approvalsCreated.length) {
          await recordAudit(ctx, {
            action: "approval_thresholds_evaluated",
            objectType: "order",
            objectId: id,
            detail: "created=" + approvalsCreated.length,
          });
        }
      }

      return json(res, 200, { order: data, approvals_created: approvalsCreated });
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
