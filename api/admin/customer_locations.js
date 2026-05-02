// /api/admin/customer_locations
//   GET ?customer_id=  list locations
//   POST upsert
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
      let q = svc.from("customer_locations").select("*").eq("tenant_id", ctx.tenantId).order("customer_id").limit(2000);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { locations: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.customer_id || !body.location_code) return json(res, 400, { error: { message: "customer_id and location_code required" } });
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        location_code: body.location_code,
        plant_name: body.plant_name || null,
        gstin: body.gstin || null,
        state_code: body.state_code || null,
        address_line1: body.address_line1 || null,
        address_line2: body.address_line2 || null,
        city: body.city || null,
        pincode: body.pincode || null,
        is_default: !!body.is_default,
      };
      if (row.is_default) {
        await svc.from("customer_locations").update({ is_default: false }).eq("tenant_id", ctx.tenantId).eq("customer_id", body.customer_id);
      }
      const { data, error } = await svc.from("customer_locations").upsert(row, { onConflict: "tenant_id,customer_id,location_code" }).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_location_upsert", objectType: "customer_location", objectId: data.id, after: data });
      return json(res, 200, { location: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("customer_locations").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_location_delete", objectType: "customer_location", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
