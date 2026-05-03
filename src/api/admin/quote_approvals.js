// /api/admin/quote_approvals
//   GET ?type=thresholds|approvals  list
//   POST upsert threshold or record approval decision
//   DELETE ?id=  remove threshold

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const type = req.query.type || "thresholds";
    if (type === "thresholds") {
      if (req.method === "GET") {
        requirePermission(ctx, "read");
        const { data, error } = await svc.from("quote_approval_thresholds").select("*").eq("tenant_id", ctx.tenantId).order("min_amount_inr");
        if (error) throw new Error(error.message);
        return json(res, 200, { thresholds: data || [] });
      }
      if (req.method === "POST") {
        requirePermission(ctx, "admin");
        const body = await readBody(req);
        const row = {
          tenant_id: ctx.tenantId,
          approver_role: body.approver_role,
          min_amount_inr: Number(body.min_amount_inr) || 0,
          max_amount_inr: body.max_amount_inr != null ? Number(body.max_amount_inr) : null,
          required_for_modes: body.required_for_modes || null,
          margin_below_pct: body.margin_below_pct != null ? Number(body.margin_below_pct) : null,
          active: body.active !== false,
        };
        const ins = body.id
          ? await svc.from("quote_approval_thresholds").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single()
          : await svc.from("quote_approval_thresholds").insert(row).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        await recordAudit(ctx, { action: "approval_threshold_upsert", objectType: "approval_threshold", objectId: ins.data.id });
        return json(res, 200, { threshold: ins.data });
      }
      if (req.method === "DELETE") {
        requirePermission(ctx, "admin");
        const id = req.query.id;
        if (!id) return json(res, 400, { error: { message: "id required" } });
        const { error } = await svc.from("quote_approval_thresholds").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
        if (error) throw new Error(error.message);
        return json(res, 200, { ok: true });
      }
    }
    if (type === "approvals") {
      if (req.method === "GET") {
        requirePermission(ctx, "read");
        let q = svc.from("quote_approvals").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
        if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return json(res, 200, { approvals: data || [] });
      }
      if (req.method === "POST") {
        requirePermission(ctx, "write");
        const body = await readBody(req);
        if (!body.order_id || !body.approver_role) return json(res, 400, { error: { message: "order_id and approver_role required" } });
        if (body.id) {
          const patch = { status: body.status || "PENDING", comments: body.comments || null, decided_at: new Date().toISOString(), approver_user: ctx.user ? ctx.user.id : null };
          const { data, error } = await svc.from("quote_approvals").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
          if (error) throw new Error(error.message);
          await recordAudit(ctx, { action: "approval_decision", objectType: "quote_approval", objectId: body.id, after: patch });
          return json(res, 200, { approval: data });
        }
        const ins = await svc.from("quote_approvals").insert({
          tenant_id: ctx.tenantId,
          order_id: body.order_id,
          approver_role: body.approver_role,
          status: body.status || "PENDING",
          comments: body.comments || null,
        }).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        await recordAudit(ctx, { action: "approval_request", objectType: "quote_approval", objectId: ins.data.id });
        return json(res, 200, { approval: ins.data });
      }
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
