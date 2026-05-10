// /api/inventory/plans
// GET                : list procurement plans (filter by status, part_no)
// POST <id>/approve  : approve a draft plan
// POST <id>/release  : release a plan -> create a source_pos row
// POST <id>/cancel   : mark superseded/cancelled
//
// The endpoint is a single function with method dispatch; the
// release path creates a `source_pos` row from the plan and links
// the two via `released_source_po_id`. Permission gates per step.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const isoToday = () => new Date().toISOString().slice(0, 10);

const releaseToSourcePO = async (svc, ctx, plan, supplier) => {
  // Build a source_pos row mirroring the plan's recommended qty + ETA.
  // The plan-release path creates a stocking PO that is not tied to a
  // specific customer order: order_id is null thanks to migration 087.
  // The supplier is resolved from item_master.default_supplier_id ->
  // suppliers; supplier_id (FK) was added by migration 087, supplier
  // (text) is kept populated for legacy readers. The doc_no /
  // created_by columns also landed in 087.
  const doc_no = "PLAN-" + plan.id.slice(0, 8) + "-" + isoToday();
  const reference = doc_no;
  const ins = await svc.from("source_pos").insert({
    tenant_id: ctx.tenantId,
    order_id: null,
    reference,
    supplier: supplier?.supplier_name || "TBD",
    supplier_id: supplier?.id || null,
    doc_no,
    status: "DRAFT",
    acknowledged_eta: plan.expected_arrival_date,
    created_by: ctx.user?.id || null,
    payload: { lineItems: [{
      partNumber: plan.part_no,
      qty: plan.recommended_qty,
      acknowledged_eta: plan.expected_arrival_date,
      released_from_plan_id: plan.id,
    }] },
  }).select("id").single();
  if (ins.error) throw new Error("source_pos insert: " + ins.error.message);
  // And the structured line.
  const line = await svc.from("source_po_lines").insert({
    tenant_id: ctx.tenantId,
    source_po_id: ins.data.id,
    line_index: 1,
    part_no: plan.part_no,
    qty: plan.recommended_qty,
    rate: null,
    uom: "Nos",
    acknowledged_eta: plan.expected_arrival_date,
    received_qty: 0,
  });
  if (line.error) throw new Error("source_po_lines insert: " + line.error.message);
  return ins.data.id;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    // Path shape: /api/inventory/plans                      -> list
    //             /api/inventory/plans/<id>/approve         -> action
    //             /api/inventory/plans/<id>/release         -> action
    //             /api/inventory/plans/<id>/cancel          -> action
    const id = segments[3];
    const action = segments[4];
    const svc = serviceClient();

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const status = url.searchParams.get("status");
      const partNo = url.searchParams.get("part_no");
      let q = svc.from("procurement_plans").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("for_week", { ascending: true })
        .limit(500);
      if (status) q = q.eq("status", status);
      if (partNo) q = q.eq("part_no", partNo);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { plans: data || [] });
    }

    if (req.method === "POST" && id && action === "approve") {
      requirePermission(ctx, "approve");
      const upd = await svc.from("procurement_plans")
        .update({
          status: "approved",
          approved_by: ctx.user?.id || null,
          approved_at: new Date().toISOString(),
        })
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .eq("status", "draft")
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.plan.approved",
        objectType: "procurement_plan",
        objectId: id,
        detail: { part_no: upd.data?.part_no, qty: upd.data?.recommended_qty },
      });
      return json(res, 200, { plan: upd.data });
    }

    if (req.method === "POST" && id && action === "release") {
      requirePermission(ctx, "approve");
      const planResp = await svc.from("procurement_plans")
        .select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (planResp.error) throw new Error(planResp.error.message);
      const plan = planResp.data;
      if (!plan) return json(res, 404, { error: { message: "Plan not found" } });
      if (plan.status !== "approved") {
        return json(res, 409, { error: { message: "Plan must be 'approved' before release" } });
      }
      // Resolve supplier from item_master -> suppliers.
      const item = await svc.from("item_master").select("default_supplier_id")
        .eq("tenant_id", ctx.tenantId).eq("part_no", plan.part_no).maybeSingle();
      let supplier = null;
      if (item.data?.default_supplier_id) {
        const s = await svc.from("suppliers").select("*")
          .eq("tenant_id", ctx.tenantId).eq("id", item.data.default_supplier_id).single();
        if (!s.error) supplier = s.data;
      }
      const sourcePoId = await releaseToSourcePO(svc, ctx, plan, supplier);
      const upd = await svc.from("procurement_plans")
        .update({ status: "released", released_source_po_id: sourcePoId })
        .eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.plan.released",
        objectType: "procurement_plan",
        objectId: id,
        detail: { source_po_id: sourcePoId, supplier: supplier?.supplier_name },
      });
      return json(res, 200, { plan: upd.data, source_po_id: sourcePoId });
    }

    if (req.method === "POST" && id && action === "cancel") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      const upd = await svc.from("procurement_plans")
        .update({ status: "cancelled", notes: body?.reason || null })
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.plan.cancelled",
        objectType: "procurement_plan",
        objectId: id,
        detail: { reason: body?.reason || null },
      });
      return json(res, 200, { plan: upd.data });
    }

    return json(res, 405, { error: { message: "Unsupported method or path" } });
  } catch (err) { sendError(res, err); }
}
