// POST /api/operator_actions/advance
// Body: { id, event: start|advance_step|attach_evidence|abandon,
//         step_id?, step_status?, notes? }
//
// Drives the operator-action state machine + per-step updates. Each
// transition writes an audit row. Flag-gated. See
// docs/OPERATOR_ACTIONS_DESIGN.md. Reconcile is a separate endpoint
// because it can require `approve`.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { nextState } from "../_lib/operator-actions.js";

const EVENTS = new Set(["start", "advance_step", "attach_evidence", "abandon"]);

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
    if (!body?.id || !body?.event) return json(res, 400, { error: { message: "id and event required" } });
    if (!EVENTS.has(body.event)) return json(res, 400, { error: { message: "unsupported event: " + body.event } });

    const aQ = await svc.from("operator_actions").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (aQ.error) throw new Error(aQ.error.message);
    if (!aQ.data) return json(res, 404, { error: { message: "Operator action not found" } });
    const action = aQ.data;

    // hasEvidence is only needed for reconcile (separate endpoint); pass false here.
    const trans = nextState(action.status, body.event, { requiresEvidence: action.requires_evidence, hasEvidence: false });
    if (trans.error) return json(res, 409, { error: { code: "ILLEGAL_TRANSITION", message: trans.error } });

    // Optional per-step update (advance_step).
    if (body.step_id) {
      const stepPatch = {};
      if (body.step_status) stepPatch.status = body.step_status;
      if (body.notes !== undefined) stepPatch.notes = body.notes;
      if (body.step_status === "done") { stepPatch.done_by = ctx.user?.id || null; stepPatch.done_at = new Date().toISOString(); }
      if (Object.keys(stepPatch).length) {
        const su = await svc.from("operator_action_steps").update(stepPatch).eq("tenant_id", ctx.tenantId).eq("id", body.step_id).eq("operator_action_id", body.id);
        if (su.error) throw new Error(su.error.message);
      }
    }

    const patch = { status: trans.status, updated_at: new Date().toISOString() };
    if (body.event === "start" && !action.started_at) { patch.started_at = new Date().toISOString(); patch.started_by = ctx.user?.id || null; }
    const upd = await svc.from("operator_actions").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
    if (upd.error) throw new Error(upd.error.message);

    await recordAudit(ctx, { action: "operator_action_" + body.event, objectType: "operator_action", objectId: body.id, detail: action.status + "->" + trans.status });
    return json(res, 200, { ok: true, action: upd.data });
  } catch (err) { sendError(res, err); }
}
