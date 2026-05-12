// /api/admin/freight_rates
//   GET    list per-tenant rates, optional ?mode=
//   POST   upsert (id optional)
//   DELETE ?id=
//
// Air per-kg + ocean per-CBM + container rates. Backs the price
// composition cockpit on quote workspace (Phase 4 / migration 106).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const MODES = new Set(["air", "ocean", "road", "courier"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("freight_rates").select("*").eq("tenant_id", ctx.tenantId).order("mode").order("origin");
      if (req.query.mode && MODES.has(req.query.mode)) q = q.eq("mode", req.query.mode);
      const { data, error } = await q.limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { rates: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.mode || !MODES.has(body.mode)) return json(res, 400, { error: { message: "mode must be air, ocean, road, courier" } });
      if (!body.unit) return json(res, 400, { error: { message: "unit required" } });
      if (body.rate_per_unit == null) return json(res, 400, { error: { message: "rate_per_unit required" } });
      const row = {
        tenant_id: ctx.tenantId,
        mode: body.mode,
        origin: body.origin || null,
        destination: body.destination || null,
        unit: body.unit,
        rate_per_unit: Number(body.rate_per_unit),
        packing_fee: body.packing_fee != null ? Number(body.packing_fee) : null,
        fuel_surcharge_pct: body.fuel_surcharge_pct != null ? Number(body.fuel_surcharge_pct) : null,
        currency: body.currency || "INR",
        effective_from: body.effective_from || null,
        effective_to: body.effective_to || null,
        is_active: body.is_active == null ? true : !!body.is_active,
        notes: body.notes || null,
      };
      const out = body.id
        ? await svc.from("freight_rates").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single()
        : await svc.from("freight_rates").insert(row).select("*").single();
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: body.id ? "freight_rate_update" : "freight_rate_create", objectType: "freight_rate", objectId: out.data.id, after: out.data });
      return json(res, 200, { rate: out.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("freight_rates").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "freight_rate_delete", objectType: "freight_rate", objectId: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
