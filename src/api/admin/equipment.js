// /api/admin/equipment - equipment hierarchy CRUD
//   GET ?customer_id= list nodes (optionally filter)
//   POST upsert node, optional installed parts
//   DELETE ?id=

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
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("equipment_hierarchy").select("*").eq("tenant_id", ctx.tenantId).order("plant_name").limit(2000);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.gun_no) q = q.eq("gun_no", req.query.gun_no);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const ids = (data || []).map((r) => r.id);
      const { data: parts } = ids.length
        ? await svc.from("equipment_installed_parts").select("*").eq("tenant_id", ctx.tenantId).in("equipment_id", ids)
        : { data: [] };
      const byEquip = {};
      (parts || []).forEach((p) => { (byEquip[p.equipment_id] = byEquip[p.equipment_id] || []).push(p); });
      return json(res, 200, { equipment: (data || []).map((r) => ({ ...r, installed_parts: byEquip[r.id] || [] })) });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
      // Generalized asset model (migration 173): asset_class discriminator +
      // attributes bag. Backward-compatible -- bodies that omit both (the
      // existing tree editor + XLSX importer) default to welding_gun/{}, and
      // the DB trigger mirrors the typed welding columns into attributes for
      // welding_gun rows regardless of what is sent here.
      const asset_class = typeof body.asset_class === "string" && body.asset_class.trim()
        ? body.asset_class.trim() : "welding_gun";
      const attributes = body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes)
        ? body.attributes : {};
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        asset_class,
        attributes,
        customer_location_id: body.customer_location_id || null,
        plant_name: body.plant_name || null,
        line_name: body.line_name || null,
        zone_name: body.zone_name || null,
        station_name: body.station_name || null,
        robot_make: body.robot_make || null,
        robot_no: body.robot_no || null,
        gun_no: body.gun_no || null,
        gun_type: body.gun_type || null,
        qty: body.qty != null ? Number(body.qty) : 1,
        timer_model: body.timer_model || null,
        atd_model: body.atd_model || null,
        parent_id: body.parent_id || null,
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
      };
      let result;
      if (body.id) {
        result = await svc.from("equipment_hierarchy").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      } else {
        result = await svc.from("equipment_hierarchy").insert(row).select("*").single();
      }
      if (result.error) throw new Error(result.error.message);
      const eqId = result.data.id;
      if (Array.isArray(body.installed_parts)) {
        await svc.from("equipment_installed_parts").delete().eq("tenant_id", ctx.tenantId).eq("equipment_id", eqId);
        const parts = body.installed_parts
          .filter((p) => p.part_no)
          .map((p) => ({
            tenant_id: ctx.tenantId,
            equipment_id: eqId,
            part_no: p.part_no,
            description: p.description || null,
            installed_qty: Number(p.installed_qty) || 1,
            is_critical: !!p.is_critical,
            is_emergency_only: !!p.is_emergency_only,
            recommended_qty_90d: p.recommended_qty_90d != null ? Number(p.recommended_qty_90d) : null,
            recommended_qty_180d: p.recommended_qty_180d != null ? Number(p.recommended_qty_180d) : null,
            recommended_qty_365d: p.recommended_qty_365d != null ? Number(p.recommended_qty_365d) : null,
            last_replaced_at: p.last_replaced_at || null,
            notes: p.notes || null,
          }));
        if (parts.length) {
          const ins = await svc.from("equipment_installed_parts").insert(parts);
          if (ins.error) throw new Error(ins.error.message);
        }
      }
      await recordAudit(ctx, { action: "equipment_upsert", objectType: "equipment_hierarchy", objectId: eqId });
      return json(res, 200, { equipment: result.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("equipment_hierarchy").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "equipment_delete", objectType: "equipment_hierarchy", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
