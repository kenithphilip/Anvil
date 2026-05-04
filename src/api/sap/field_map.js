// GET / PUT /api/sap/field_map - tenant-configurable field overrides for SO push.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

const validate = (map) => {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw Object.assign(new Error("field_map must be a JSON object"), { status: 400 });
  }
  if (Object.keys(map).length > 50) throw Object.assign(new Error("too many entries"), { status: 400 });
  for (const [k, v] of Object.entries(map)) {
    if (typeof k !== "string" || !k.length || typeof v !== "string" || !v.length) {
      throw Object.assign(new Error("invalid entry"), { status: 400 });
    }
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const settings = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, { field_map: settings?.sap_field_map || {} });
    }
    if (req.method === "PUT" || req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const map = body?.field_map ?? {};
      validate(map);
      await tenantSettings(svc, ctx.tenantId);
      const updated = await updateTenantSettings(svc, ctx.tenantId, { sap_field_map: map });
      await recordAudit(ctx, { action: "sap_field_map_updated", objectType: "tenant_settings", objectId: ctx.tenantId, detail: "entries=" + Object.keys(map).length });
      return json(res, 200, { ok: true, field_map: updated?.sap_field_map || {} });
    }
    res.setHeader("Allow", "GET, PUT");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
