// CRUD for redaction_rules. POST upserts, GET lists, DELETE removes.
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
      const { data, error } = await svc.from("redaction_rules").select("*").or("tenant_id.is.null,tenant_id.eq." + ctx.tenantId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return json(res, 200, { rules: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body || !body.field_path || !body.pattern) return json(res, 400, { error: { message: "field_path and pattern required" } });
      const insert = await svc.from("redaction_rules").insert({
        tenant_id: ctx.tenantId,
        field_path: body.field_path,
        pattern: body.pattern,
        replacement: body.replacement || "[REDACTED]",
        enabled: body.enabled !== false,
        notes: body.notes || null,
      }).select("*").single();
      if (insert.error) throw new Error(insert.error.message);
      await recordAudit(ctx, { action: "redaction_rule_create", objectType: "redaction_rule", objectId: insert.data.id, detail: body.field_path });
      return json(res, 200, { rule: insert.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("redaction_rules").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
