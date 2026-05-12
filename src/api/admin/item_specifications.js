// /api/admin/item_specifications
//   GET   ?item_id=...         single spec row
//   POST  upsert
//
// 1-to-1 with item_master.id. Carries the engineering surface:
// technical description, drawing number, gun number, customer
// project, material, feasibility, lifetime, picture, MOQ, remark.
//
// Separate from item_master so the master stays narrow and tenants
// that do not use the engineering surface keep their schema clean.
// Migration 105 enforces FK + RLS.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const FEASIBILITY = new Set(["yes", "no", "tbd"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const itemId = req.query.item_id;
      if (!itemId) return json(res, 400, { error: { message: "item_id required" } });
      const { data, error } = await svc.from("item_specifications")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("item_id", itemId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return json(res, 200, { spec: data || null });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.item_id) return json(res, 400, { error: { message: "item_id required" } });
      const feasibility = body.mfg_feasibility
        ? (FEASIBILITY.has(String(body.mfg_feasibility).toLowerCase()) ? String(body.mfg_feasibility).toLowerCase() : "tbd")
        : null;
      const row = {
        item_id: body.item_id,
        tenant_id: ctx.tenantId,
        technical_description: body.technical_description || null,
        drawing_number: body.drawing_number || null,
        alternate_part_number: body.alternate_part_number || null,
        gun_number: body.gun_number || null,
        customer_project: body.customer_project || null,
        source_country: body.source_country || null,
        material: body.material || null,
        drawing_available: body.drawing_available == null ? null : !!body.drawing_available,
        mfg_feasibility: feasibility,
        specified_life_time: body.specified_life_time || null,
        picture_url: body.picture_url || null,
        minimum_order_qty: body.minimum_order_qty != null && body.minimum_order_qty !== "" ? Number(body.minimum_order_qty) : null,
        minimum_inventory: body.minimum_inventory != null && body.minimum_inventory !== "" ? Number(body.minimum_inventory) : null,
        remark: body.remark || null,
      };
      const { data, error } = await svc.from("item_specifications")
        .upsert(row, { onConflict: "item_id" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_specifications_upsert", objectType: "item_master", objectId: body.item_id, after: data });
      return json(res, 200, { spec: data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
