// POST /api/operator_actions/reconcile
// Body: { id, payload_hash?, reconcile_contract? }
//
// The governed write-back of an operator action. The reconcile contract
// (from the action, or overridden in the body) is validated and executed:
//   - note   : append an audited note + case-timeline event (no system-
//              of-record mutation) -> requires `write`.
//   - status : set orders.status behind the order's approval guard
//              (requireApprovedOrder) -> requires `approve`.
// Sets the action to `reconciled` and audits. Flag-gated. See
// docs/OPERATOR_ACTIONS_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { requireApprovedOrder } from "../_lib/erp-runner.js";
import { nextState, validateReconcileContract } from "../_lib/operator-actions.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!settings?.operator_actions_enabled) return json(res, 409, { error: { code: "FEATURE_DISABLED", message: "Operator actions are disabled for this tenant" } });

    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id required" } });

    const aQ = await svc.from("operator_actions").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (aQ.error) throw new Error(aQ.error.message);
    if (!aQ.data) return json(res, 404, { error: { message: "Operator action not found" } });
    const action = aQ.data;

    const contract = (body.reconcile_contract && Object.keys(body.reconcile_contract).length) ? body.reconcile_contract : action.reconcile_contract;
    const v = validateReconcileContract(contract);
    if (v.error) return json(res, 400, { error: { code: "BAD_CONTRACT", message: v.error } });

    // Escalate to approve when the reconcile mutates a system of record.
    if (v.mutatesSor) requirePermission(ctx, "approve");

    // State gate: reconcile requires evidence when the action demands it.
    const evCount = await svc.from("operator_action_evidence").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("operator_action_id", body.id);
    const hasEvidence = (evCount.count || 0) > 0;
    const trans = nextState(action.status, "reconcile", { requiresEvidence: action.requires_evidence, hasEvidence });
    if (trans.error) return json(res, 409, { error: { code: "ILLEGAL_TRANSITION", message: trans.error } });

    let result;
    if (v.type === "note") {
      if (action.object_id) {
        await recordEvent(ctx, { caseId: action.object_id, eventType: "operator_action_note", objectType: action.object_type || "operator_action", objectId: body.id, detail: String(contract.text).slice(0, 400) });
      }
      result = { type: "note", noted: true };
    } else {
      // status: guarded order mutation
      const orderId = contract.target.object_id;
      const oQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
      if (oQ.error) throw new Error(oQ.error.message);
      if (!oQ.data) return json(res, 404, { error: { message: "Target order not found" } });
      const guard = requireApprovedOrder(oQ.data, body.payload_hash);
      if (guard) return json(res, guard.status, guard.body);
      const newStatus = contract.set.value;
      const ou = await svc.from("orders").update({ status: newStatus }).eq("tenant_id", ctx.tenantId).eq("id", orderId);
      if (ou.error) throw new Error(ou.error.message);
      await recordEvent(ctx, { caseId: orderId, eventType: "operator_action_reconciled", objectType: "order", objectId: orderId, detail: "status=" + newStatus });
      result = { type: "status", order_id: orderId, status: newStatus };
    }

    const upd = await svc.from("operator_actions").update({
      status: "reconciled",
      reconciled_by: ctx.user?.id || null,
      reconciled_at: new Date().toISOString(),
      reconcile_result: result,
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
    if (upd.error) throw new Error(upd.error.message);

    await recordAudit(ctx, { action: "operator_action_reconcile", objectType: "operator_action", objectId: body.id, detail: v.type + (v.mutatesSor ? "::sor" : "::note") });
    return json(res, 200, { ok: true, action: upd.data, result });
  } catch (err) { sendError(res, err); }
}
