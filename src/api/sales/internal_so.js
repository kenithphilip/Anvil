// /api/sales/internal_so
//   GET    list (filter by type, status)
//   POST   create with optional lines
//   PATCH  update
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const TYPES = new Set(["FOC_SUPPLY","WARRANTY_REPLACEMENT","PRODUCT_TRIAL","EXPECTED_PO","INTERNAL_TRANSFER"]);
const STATUSES = new Set(["DRAFT","PENDING_APPROVAL","APPROVED","DISPATCHED","CLOSED","CANCELLED"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("internal_sales_orders").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.type && TYPES.has(req.query.type)) q = q.eq("iso_type", req.query.type);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const ids = (data || []).map((r) => r.id);
      const { data: lines } = ids.length
        ? await svc.from("internal_so_lines").select("*").eq("tenant_id", ctx.tenantId).in("internal_so_id", ids)
        : { data: [] };
      const byIso = {};
      (lines || []).forEach((ln) => { (byIso[ln.internal_so_id] = byIso[ln.internal_so_id] || []).push(ln); });
      return json(res, 200, { internalSos: (data || []).map((r) => ({ ...r, lines: byIso[r.id] || [] })) });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.iso_type || !TYPES.has(body.iso_type)) return json(res, 400, { error: { message: "valid iso_type required" } });
      if (!body.iso_number) return json(res, 400, { error: { message: "iso_number required" } });
      const row = {
        tenant_id: ctx.tenantId,
        iso_type: body.iso_type,
        iso_number: body.iso_number,
        purpose: body.purpose || null,
        requested_person: body.requested_person || null,
        requested_date: body.requested_date || null,
        customer_id: body.customer_id || null,
        customer_location_id: body.customer_location_id || null,
        vendor_name: body.vendor_name || null,
        vendor_address: body.vendor_address || null,
        material_requirement: body.material_requirement || null,
        required_date: body.required_date || null,
        approximate_cost_inr: body.approximate_cost_inr || null,
        billing_instruction: body.billing_instruction || null,
        estimated_life: body.estimated_life || null,
        purchase_location: body.purchase_location || null,
        budget: body.budget || null,
        warranty_reference: body.warranty_reference || null,
        expected_po_reference: body.expected_po_reference || null,
        trial_outcome: body.trial_outcome || null,
        from_store: body.from_store || null,
        to_store: body.to_store || null,
        status: STATUSES.has(body.status) ? body.status : "DRAFT",
        payload: body.payload || {},
      };
      const ins = await svc.from("internal_sales_orders").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      const isoId = ins.data.id;
      if (Array.isArray(body.lines) && body.lines.length) {
        const lineRows = body.lines.map((ln) => ({
          tenant_id: ctx.tenantId,
          internal_so_id: isoId,
          part_no: ln.part_no || null,
          description: ln.description || null,
          qty: Number(ln.qty) || 0,
          uom: ln.uom || null,
          estimated_cost: Number(ln.estimated_cost) || null,
          notes: ln.notes || null,
        }));
        const linesIns = await svc.from("internal_so_lines").insert(lineRows);
        if (linesIns.error) throw new Error(linesIns.error.message);
      }
      await recordAudit(ctx, { action: "iso_create", objectType: "internal_so", objectId: isoId, after: ins.data });
      return json(res, 201, { internalSo: ins.data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      const allowed = ["status","purpose","material_requirement","required_date","approximate_cost_inr","billing_instruction","trial_outcome","approved_by","approved_at","from_store","to_store","budget","payload"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (body.status === "APPROVED" && !patch.approved_at) {
        patch.approved_at = new Date().toISOString();
        patch.approved_by = ctx.user ? ctx.user.id : null;
      }
      const { data, error } = await svc.from("internal_sales_orders").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "iso_update", objectType: "internal_so", objectId: body.id, after: patch });
      return json(res, 200, { internalSo: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("internal_sales_orders").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "iso_delete", objectType: "internal_so", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
