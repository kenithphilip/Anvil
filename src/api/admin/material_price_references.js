// /api/admin/material_price_references
//   GET    ?material_key=&uom=     (filter) or all for the tenant
//   POST   upsert one reference    { material_key, uom?, unit_price, currency?, source?, as_of? }
//   DELETE ?id=...
//
// P3 raw-material price reference: the central, market-tracking price
// for raw materials. The composition endpoint fills recipe material-line
// unit_cost from here (see _lib/material-prices.js).

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
      let q = svc.from("material_price_references").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.material_key) q = q.eq("material_key", req.query.material_key);
      if (req.query.uom) q = q.eq("uom", req.query.uom);
      const { data, error } = await q.order("as_of", { ascending: false });
      if (error) throw new Error(error.message);
      return json(res, 200, { references: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.material_key) return json(res, 400, { error: { message: "material_key required" } });
      if (body.unit_price == null || body.unit_price === "" || !Number.isFinite(Number(body.unit_price))) {
        return json(res, 400, { error: { message: "unit_price (number) required" } });
      }
      const row = {
        tenant_id: ctx.tenantId,
        material_key: String(body.material_key),
        uom: body.uom || "kg",
        unit_price: Number(body.unit_price),
        currency: body.currency || "INR",
        source: body.source || "manual",
        as_of: body.as_of || new Date().toISOString().slice(0, 10),
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
      };
      const up = await svc.from("material_price_references")
        .upsert(row, { onConflict: "tenant_id,material_key,uom,as_of" })
        .select("*").single();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "material_price_reference_upsert",
        objectType: "material", objectId: row.material_key,
        after: { unit_price: row.unit_price, currency: row.currency, as_of: row.as_of },
      });
      return json(res, 200, { reference: up.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("material_price_references")
        .delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
