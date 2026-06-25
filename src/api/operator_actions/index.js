// /api/operator_actions
//   GET  list (?status=&object_id=) | one (?id=)
//   POST create an action + its ordered steps
//
// Governed operator actions (PR4). Flag-gated by
// tenant_settings.operator_actions_enabled. See
// docs/OPERATOR_ACTIONS_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { validateReconcileContract } from "../_lib/operator-actions.js";

const featureGuard = async (svc, ctx) => {
  const settings = await tenantSettings(svc, ctx.tenantId);
  if (!settings?.operator_actions_enabled) {
    return { status: 409, body: { error: { code: "FEATURE_DISABLED", message: "Operator actions are disabled for this tenant" } } };
  }
  return null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const gated = await featureGuard(svc, ctx);
    if (gated) return json(res, gated.status, gated.body);

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (req.query.id) {
        const a = await svc.from("operator_actions").select("*").eq("tenant_id", ctx.tenantId).eq("id", req.query.id).maybeSingle();
        if (a.error) throw new Error(a.error.message);
        if (!a.data) return json(res, 404, { error: { message: "Operator action not found" } });
        const steps = await svc.from("operator_action_steps").select("*").eq("tenant_id", ctx.tenantId).eq("operator_action_id", req.query.id).order("seq", { ascending: true });
        const evidence = await svc.from("operator_action_evidence").select("*").eq("tenant_id", ctx.tenantId).eq("operator_action_id", req.query.id).order("created_at", { ascending: false });
        return json(res, 200, { action: a.data, steps: steps.data || [], evidence: evidence.data || [] });
      }
      let q = svc.from("operator_actions").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.status) q = q.eq("status", req.query.status);
      if (req.query.object_id) q = q.eq("object_id", req.query.object_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { actions: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.title) return json(res, 400, { error: { message: "title required" } });
      const steps = Array.isArray(body.steps) ? body.steps.filter((s) => s && s.instruction) : [];
      if (body.reconcile_contract && Object.keys(body.reconcile_contract).length) {
        const v = validateReconcileContract(body.reconcile_contract);
        if (v.error) return json(res, 400, { error: { message: "reconcile_contract: " + v.error } });
      }
      const ins = await svc.from("operator_actions").insert({
        tenant_id: ctx.tenantId,
        action_type: body.action_type || null,
        title: body.title,
        target_system: body.target_system || null,
        object_type: body.object_type || null,
        object_id: body.object_id || null,
        status: "proposed",
        requires_evidence: body.requires_evidence !== false,
        reconcile_contract: body.reconcile_contract || {},
        driver: "human",
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);

      if (steps.length) {
        const rows = steps.map((s, i) => ({
          tenant_id: ctx.tenantId,
          operator_action_id: ins.data.id,
          seq: i + 1,
          instruction: s.instruction,
          expected: s.expected || null,
        }));
        const si = await svc.from("operator_action_steps").insert(rows);
        if (si.error) throw new Error(si.error.message);
      }
      await recordAudit(ctx, { action: "operator_action_create", objectType: "operator_action", objectId: ins.data.id, detail: body.title });
      return json(res, 201, { action: ins.data, step_count: steps.length });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
