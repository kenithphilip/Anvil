// POST /api/inventory/sync
// Body: { records: [{ stockItemName, available_qty, reserved_qty?, reorder_level?, uom? }], replace? }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const records = Array.isArray(body.records) ? body.records : [];
    if (!records.length) return json(res, 200, { ok: true, count: 0 });
    const svc = serviceClient();
    if (body.replace) {
      const del = await svc.from("tally_inventory").delete().eq("tenant_id", ctx.tenantId);
      if (del.error) throw new Error(del.error.message);
    }
    const rows = records.map((r) => ({
      tenant_id: ctx.tenantId,
      stock_item_name: String(r.stockItemName || r.name || "").trim(),
      available_qty: Number(r.available_qty || r.availableQty || 0),
      reserved_qty: Number(r.reserved_qty || r.reservedQty || 0),
      reorder_level: Number(r.reorder_level || r.reorderLevel || 0),
      uom: r.uom || null,
      last_sync_at: new Date().toISOString(),
    })).filter((row) => row.stock_item_name);
    if (!rows.length) return json(res, 200, { ok: true, count: 0 });
    const upsert = await svc.from("tally_inventory").upsert(rows, { onConflict: "tenant_id,stock_item_name" });
    if (upsert.error) throw new Error(upsert.error.message);
    await recordAudit(ctx, { action: "inventory_sync", objectType: "tally_inventory", objectId: null, detail: "rows=" + rows.length + " replace=" + !!body.replace });
    return json(res, 200, { ok: true, count: rows.length });
  } catch (err) {
    sendError(res, err);
  }
}
