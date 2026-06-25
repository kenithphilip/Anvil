// GET    /api/bom/source_formats          - effective formats (built-ins + tenant)
// PUT|POST /api/bom/source_formats         - upsert a tenant format / override
// DELETE /api/bom/source_formats?key=...   - remove a tenant format (reverts to built-in)
//
// The tenant-configurable BOM source-format registry. Built-in profiles
// live in _lib/bom-format.js; this endpoint merges tenant rows over them.
// See docs/BOM_INGESTION_DESIGN.md section 3.3.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { mergeFormats } from "../_lib/bom-format.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("bom_source_formats").select("*").eq("tenant_id", tenantId);
      if (error) throw new Error(error.message);
      return json(res, 200, { formats: mergeFormats(data || []) });
    }

    if (req.method === "PUT" || req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const key = body?.key ? String(body.key).trim() : "";
      if (!key) return json(res, 400, { error: { message: "key required" } });
      if (body.column_map != null && !isObj(body.column_map)) return json(res, 400, { error: { message: "column_map must be an object" } });
      if (body.detect != null && !isObj(body.detect)) return json(res, 400, { error: { message: "detect must be an object" } });
      if (body.quirks != null && !isObj(body.quirks)) return json(res, 400, { error: { message: "quirks must be an object" } });
      const row = {
        tenant_id: tenantId,
        key,
        label: body.label != null ? String(body.label) : null,
        source_country: body.source_country != null ? String(body.source_country) : null,
        column_map: body.column_map || {},
        detect: body.detect || {},
        quirks: body.quirks || {},
        enabled: body.enabled !== false,
        created_by: ctx.userId || null,
        updated_at: new Date().toISOString(),
      };
      const up = await svc.from("bom_source_formats").upsert(row, { onConflict: "tenant_id,key" }).select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, { action: "bom_source_format_saved", objectType: "bom_source_format", objectId: key, detail: "key=" + key });
      return json(res, 200, { ok: true, format: up.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const key = req.query.key;
      if (!key) return json(res, 400, { error: { message: "key required" } });
      const del = await svc.from("bom_source_formats").delete().eq("tenant_id", tenantId).eq("key", key);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "bom_source_format_deleted", objectType: "bom_source_format", objectId: key, detail: "key=" + key });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, PUT, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
