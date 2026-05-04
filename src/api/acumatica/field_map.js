// GET / PUT /api/acumatica/field_map

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

const validate = (m) => {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw Object.assign(new Error("field_map must be a JSON object"), { status: 400 });
  if (Object.keys(m).length > 50) throw Object.assign(new Error("too many entries"), { status: 400 });
  for (const [k, v] of Object.entries(m)) {
    if (typeof k !== "string" || !k || typeof v !== "string" || !v) throw Object.assign(new Error("invalid entry"), { status: 400 });
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
      const s = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, { field_map: s?.acumatica_field_map || {} });
    }
    if (req.method === "PUT" || req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const map = body?.field_map ?? {};
      validate(map);
      await tenantSettings(svc, ctx.tenantId);
      const u = await updateTenantSettings(svc, ctx.tenantId, { acumatica_field_map: map });
      await recordAudit(ctx, { action: "acumatica_field_map_updated", objectType: "tenant_settings", objectId: ctx.tenantId, detail: "entries=" + Object.keys(map).length });
      return json(res, 200, { ok: true, field_map: u?.acumatica_field_map || {} });
    }
    res.setHeader("Allow", "GET, PUT");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
