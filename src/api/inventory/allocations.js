// /api/inventory/allocations
// GET    : list allocations (filter by part_no, project_id, status)
// POST   : create a reservation
// PATCH <id> : modify (qty, required_by, status)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments[3];
    const svc = serviceClient();

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const partNo = url.searchParams.get("part_no");
      const projectId = url.searchParams.get("project_id");
      const status = url.searchParams.get("status");
      let q = svc.from("inventory_allocations").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("required_by", { ascending: true })
        .limit(500);
      if (partNo) q = q.eq("part_no", partNo);
      if (projectId) q = q.eq("project_id", projectId);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { allocations: data || [] });
    }

    if (req.method === "POST" && !id) {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.part_no || !body?.qty || !body?.required_by) {
        return json(res, 400, { error: { message: "part_no, qty, required_by required" } });
      }
      const ins = await svc.from("inventory_allocations").insert({
        tenant_id: ctx.tenantId,
        project_id: body.project_id || null,
        order_id: body.order_id || null,
        opportunity_id: body.opportunity_id || null,
        part_no: body.part_no,
        qty: Number(body.qty),
        required_by: body.required_by,
        status: "reserved",
        reason_text: body.reason_text || null,
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "inventory.allocation.created",
        objectType: "inventory_allocation",
        objectId: ins.data.id,
        detail: { part_no: ins.data.part_no, qty: ins.data.qty, project_id: ins.data.project_id },
      });
      return json(res, 200, { allocation: ins.data });
    }

    if (req.method === "PATCH" && id) {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const patch = {};
      if (typeof body?.qty === "number") patch.qty = body.qty;
      if (body?.required_by) patch.required_by = body.required_by;
      if (body?.status && ["reserved", "consumed", "released", "expired"].includes(body.status)) {
        patch.status = body.status;
        if (body.status === "consumed") patch.consumed_at = new Date().toISOString();
        if (body.status === "released") patch.released_at = new Date().toISOString();
      }
      if (body?.reason_text) patch.reason_text = body.reason_text;
      const upd = await svc.from("inventory_allocations")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      // Phase 3.5: distinguish "released back to free pool" from a
      // generic update so the audit-event taxonomy in doc 7.10 is
      // honoured.
      const action = patch.status === "released"
        ? "inventory.allocation.released"
        : patch.status === "consumed"
          ? "inventory.allocation.consumed"
          : "inventory.allocation.updated";
      await recordAudit(ctx, {
        action,
        objectType: "inventory_allocation",
        objectId: id,
        detail: patch,
      });
      return json(res, 200, { allocation: upd.data });
    }

    return json(res, 405, { error: { message: "Unsupported method or path" } });
  } catch (err) { sendError(res, err); }
}
