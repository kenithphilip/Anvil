// /api/admin/inventory
//   GET    ?q=&limit=  list tally_inventory rows
//   POST   { stock_item_name, available_qty, reserved_qty, reorder_level, uom } upsert
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
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit || 500)));
      let q = svc.from("tally_inventory").select("*").eq("tenant_id", ctx.tenantId).order("stock_item_name", { ascending: true }).limit(limit);
      if (req.query.q) {
        const safe = String(req.query.q).replace(/[%_]/g, "\\$&");
        q = q.ilike("stock_item_name", "%" + safe + "%");
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { items: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.stock_item_name) return json(res, 400, { error: { message: "stock_item_name required" } });
      const row = {
        tenant_id: ctx.tenantId,
        stock_item_name: body.stock_item_name,
        available_qty: Number(body.available_qty) || 0,
        reserved_qty: Number(body.reserved_qty) || 0,
        reorder_level: Number(body.reorder_level) || 0,
        uom: body.uom || null,
        last_sync_at: new Date().toISOString(),
      };
      const { data, error } = await svc.from("tally_inventory").upsert(row, { onConflict: "tenant_id,stock_item_name" }).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "inventory_upsert", objectType: "tally_inventory", objectId: data.id, after: data });
      return json(res, 200, { item: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("tally_inventory").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "inventory_delete", objectType: "tally_inventory", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
