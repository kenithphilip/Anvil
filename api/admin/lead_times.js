// /api/admin/lead_times?type=customer|supplier
//   GET    list rows
//   POST   upsert row
//   DELETE ?id=  remove row

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const TABLES = {
  customer: "customer_lead_times",
  supplier: "supplier_lead_times",
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const type = String(req.query.type || "supplier").toLowerCase();
    const table = TABLES[type];
    if (!table) return json(res, 400, { error: { message: "type must be customer or supplier" } });
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from(table).select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { rows: data || [], type });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const lead = Number(body.lead_days);
      if (!Number.isFinite(lead) || lead < 0 || lead > 365) {
        return json(res, 400, { error: { message: "lead_days must be 0..365" } });
      }
      const base = {
        tenant_id: ctx.tenantId,
        product_category: body.product_category || null,
        lead_days: lead,
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
      };
      const row = type === "customer"
        ? { ...base, customer_id: body.customer_id || null }
        : { ...base, supplier: body.supplier || null, country: String(body.country || "").toUpperCase() };
      let result;
      if (body.id) {
        result = await svc.from(table).update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      } else {
        result = await svc.from(table).insert(row).select("*").single();
      }
      if (result.error) throw new Error(result.error.message);
      await recordAudit(ctx, { action: type + "_lead_time_upsert", objectType: table, objectId: result.data.id, after: result.data });
      return json(res, 200, { row: result.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from(table).delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: type + "_lead_time_delete", objectType: table, objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
