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
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
      let query = svc.from("audit_events").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(limit);
      if (req.query.action) query = query.eq("action", req.query.action);
      if (req.query.object_id) query = query.eq("object_id", req.query.object_id);
      if (req.query.object_type) query = query.eq("object_type", req.query.object_type);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return json(res, 200, { events: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body || !body.action) return json(res, 400, { error: { message: "action required" } });
      await recordAudit(ctx, body);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
