// Shared GET / PUT handler for connector field-map endpoints.
//
// The seven full connectors (sap, netsuite, d365, acumatica, p21,
// eclipse, sxe) each ship a near-identical standalone field_map.js.
// Rather than paste nine more copies for the lite connectors, this
// helper captures that exact contract once and is parameterised by
// the per-tenant settings column and audit action. A connector's
// field_map.js becomes a one-line default export.
//
// Contract preserved verbatim from sap/field_map.js + p21/field_map.js:
//   GET  -> read:  { field_map: <settings[column] or {}> }
//   PUT  -> admin: validate, persist on tenant_settings, audit,
//                  return { ok: true, field_map }
//   POST is accepted as an alias for PUT (matches the references).

import { applyCors, handlePreflight, json, readBody, sendError } from "./cors.js";
import { resolveContext, requirePermission } from "./auth.js";
import { serviceClient } from "./supabase.js";
import { recordAudit } from "./audit.js";
import { tenantSettings, updateTenantSettings } from "./stripe-client.js";

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

// settingsColumn: the tenant_settings JSONB column, e.g. "ifs_field_map".
// auditAction:    the recordAudit action string, e.g. "ifs_field_map_updated".
export const connectorFieldMapHandler = (settingsColumn, auditAction) =>
  async function handler(req, res) {
    if (handlePreflight(req, res)) return;
    applyCors(req, res);
    try {
      const ctx = await resolveContext(req);
      const svc = serviceClient();
      if (req.method === "GET") {
        requirePermission(ctx, "read");
        const settings = await tenantSettings(svc, ctx.tenantId);
        return json(res, 200, { field_map: settings?.[settingsColumn] || {} });
      }
      if (req.method === "PUT" || req.method === "POST") {
        requirePermission(ctx, "admin");
        const body = await readBody(req);
        const map = body?.field_map ?? {};
        validate(map);
        await tenantSettings(svc, ctx.tenantId);
        const updated = await updateTenantSettings(svc, ctx.tenantId, { [settingsColumn]: map });
        await recordAudit(ctx, { action: auditAction, objectType: "tenant_settings", objectId: ctx.tenantId, detail: "entries=" + Object.keys(map).length });
        return json(res, 200, { ok: true, field_map: updated?.[settingsColumn] || {} });
      }
      res.setHeader("Allow", "GET, PUT");
      return json(res, 405, { error: { message: "Method not allowed" } });
    } catch (err) { sendError(res, err); }
  };
