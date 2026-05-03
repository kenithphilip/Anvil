import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordEvent } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const caseId = req.query.case_id;
      if (!caseId) return json(res, 400, { error: { message: "case_id required" } });
      const { data, error } = await svc.from("processing_events").select("*").eq("tenant_id", ctx.tenantId).eq("case_id", caseId).order("created_at");
      if (error) throw new Error(error.message);
      return json(res, 200, { events: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.case_id || !body.event_type) return json(res, 400, { error: { message: "case_id and event_type required" } });
      await recordEvent(ctx, {
        caseId: body.case_id,
        eventType: body.event_type,
        objectType: body.object_type || "order",
        objectId: body.object_id,
        detail: body.detail || {},
        durationMs: body.duration_ms || null,
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
