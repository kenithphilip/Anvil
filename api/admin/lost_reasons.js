// /api/admin/lost_reasons - taxonomy CRUD

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
      const { data, error } = await svc.from("lost_reason_taxonomy").select("*")
        .or("tenant_id.eq." + ctx.tenantId + ",tenant_id.is.null").order("category");
      if (error) throw new Error(error.message);
      return json(res, 200, { reasons: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.code || !body.label) return json(res, 400, { error: { message: "code and label required" } });
      const row = {
        tenant_id: ctx.tenantId,
        code: body.code,
        label: body.label,
        category: body.category || null,
        active: body.active !== false,
      };
      const { data, error } = await svc.from("lost_reason_taxonomy").upsert(row, { onConflict: "tenant_id,code" }).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "lost_reason_upsert", objectType: "lost_reason", objectId: data.id, after: data });
      return json(res, 200, { reason: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("lost_reason_taxonomy").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "lost_reason_delete", objectType: "lost_reason", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
