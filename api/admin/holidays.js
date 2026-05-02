// /api/admin/holidays
//   GET    ?country=&from=&to=    list holidays for current tenant + global
//   POST   { country, date, name } create or upsert
//   DELETE ?id=                   remove a holiday
// All admin actions require tenant manager or higher.

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
      let query = svc.from("holiday_calendar").select("*").or("tenant_id.eq." + ctx.tenantId + ",tenant_id.is.null").order("date", { ascending: true });
      if (req.query.country) query = query.eq("country", String(req.query.country).toUpperCase());
      if (req.query.from) query = query.gte("date", req.query.from);
      if (req.query.to) query = query.lte("date", req.query.to);
      const { data, error } = await query.limit(2000);
      if (error) throw new Error(error.message);
      return json(res, 200, { holidays: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.country || !body.date) return json(res, 400, { error: { message: "country and date required" } });
      const row = {
        tenant_id: ctx.tenantId,
        country: String(body.country).toUpperCase(),
        date: body.date,
        name: body.name || null,
      };
      const { data, error } = await svc.from("holiday_calendar")
        .upsert(row, { onConflict: "tenant_id,country,date" })
        .select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "holiday_upsert", objectType: "holiday_calendar", objectId: data.id, after: data });
      return json(res, 200, { holiday: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("holiday_calendar").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "holiday_delete", objectType: "holiday_calendar", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
