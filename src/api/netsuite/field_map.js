// GET or PUT /api/netsuite/field_map
//
// Tenant-configurable override for how Anvil renders fields onto a
// NetSuite Sales Order. Map shape:
//
//   { "<source.dot.path>": "<target.dot.path>" }
//
// Source paths reference the rendered payload (the result of
// buildSalesOrderPayload), target paths are where to move that
// value to. Example: { "memo": "custbody_short_memo" } moves the
// memo string into a custom NetSuite body field.
//
// GET returns the current map.
// PUT body { field_map: {...} } replaces it.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

const validate = (map) => {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw Object.assign(new Error("field_map must be a JSON object"), { status: 400 });
  }
  for (const [k, v] of Object.entries(map)) {
    if (typeof k !== "string" || !k.length) {
      throw Object.assign(new Error("invalid map key"), { status: 400 });
    }
    if (typeof v !== "string" || !v.length) {
      throw Object.assign(new Error("invalid map value for " + k), { status: 400 });
    }
    if (k.length > 256 || v.length > 256) {
      throw Object.assign(new Error("path too long: " + k), { status: 400 });
    }
  }
  if (Object.keys(map).length > 50) {
    throw Object.assign(new Error("too many entries (max 50)"), { status: 400 });
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
      return json(res, 200, { field_map: settings?.netsuite_field_map || {} });
    }

    if (req.method === "PUT" || req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const map = body?.field_map ?? {};
      validate(map);
      await tenantSettings(svc, ctx.tenantId);
      const updated = await updateTenantSettings(svc, ctx.tenantId, {
        netsuite_field_map: map,
      });
      await recordAudit(ctx, {
        action: "netsuite_field_map_updated",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: "entries=" + Object.keys(map).length,
      });
      return json(res, 200, { ok: true, field_map: updated?.netsuite_field_map || {} });
    }

    res.setHeader("Allow", "GET, PUT");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
