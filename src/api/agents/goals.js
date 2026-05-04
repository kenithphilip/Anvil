// /api/agents/goals
//
// GET    list this tenant's goals (filterable by status + goal_type)
// POST   arm a new goal: { goal_type, object_type, object_id, due_at?, config? }
// PATCH  update a goal: { id, status?, next_run_at?, due_at?, config? }
// DELETE archive a goal (sets status = cancelled rather than hard delete)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { KNOWN_GOAL_TYPES } from "./_handlers/index.js";

const VALID_STATUS = new Set(["active", "paused", "completed", "cancelled", "failed"]);
const VALID_OBJECT_TYPES = new Set(["order", "einvoice"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("agent_goals").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query?.status && VALID_STATUS.has(req.query.status)) {
        q = q.eq("status", req.query.status);
      }
      if (req.query?.goal_type && KNOWN_GOAL_TYPES.includes(req.query.goal_type)) {
        q = q.eq("goal_type", req.query.goal_type);
      }
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw new Error(error.message);

      // Pull recent steps in one query so the UI can render a timeline
      // without N+1ing.
      const ids = (data || []).map((g) => g.id);
      let steps = [];
      if (ids.length) {
        const sr = await svc
          .from("agent_steps")
          .select("*")
          .eq("tenant_id", ctx.tenantId)
          .in("goal_id", ids)
          .order("step_no", { ascending: false })
          .limit(500);
        if (!sr.error) steps = sr.data || [];
      }
      return json(res, 200, { goals: data || [], steps });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.goal_type || !KNOWN_GOAL_TYPES.includes(body.goal_type)) {
        return json(res, 400, { error: { message: "valid goal_type required, one of " + KNOWN_GOAL_TYPES.join(", ") } });
      }
      if (!body?.object_type || !VALID_OBJECT_TYPES.has(body.object_type)) {
        return json(res, 400, { error: { message: "object_type required (order or einvoice)" } });
      }
      if (!body?.object_id) {
        return json(res, 400, { error: { message: "object_id required" } });
      }
      const row = {
        tenant_id: ctx.tenantId,
        goal_type: body.goal_type,
        object_type: body.object_type,
        object_id: body.object_id,
        due_at: body.due_at || null,
        config: body.config || {},
        created_by: ctx.user?.id || null,
        owner_user_id: body.owner_user_id || ctx.user?.id || null,
      };
      const ins = await svc.from("agent_goals").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "agent_goal_armed",
        objectType: "agent_goals",
        objectId: ins.data.id,
        after: { goal_type: body.goal_type, object_type: body.object_type, object_id: body.object_id },
      });
      return json(res, 200, { goal: ins.data });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      if (body.status) {
        if (!VALID_STATUS.has(body.status)) {
          return json(res, 400, { error: { message: "invalid status" } });
        }
        patch.status = body.status;
      }
      if (body.next_run_at) patch.next_run_at = body.next_run_at;
      if (body.due_at) patch.due_at = body.due_at;
      if (body.config) patch.config = body.config;
      const upd = await svc
        .from("agent_goals")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", body.id)
        .select("*")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "agent_goal_updated",
        objectType: "agent_goals",
        objectId: body.id,
        after: patch,
      });
      return json(res, 200, { goal: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query?.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const upd = await svc
        .from("agent_goals")
        .update({ status: "cancelled" })
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "agent_goal_cancelled",
        objectType: "agent_goals",
        objectId: id,
      });
      return json(res, 200, { goal: upd.data });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
