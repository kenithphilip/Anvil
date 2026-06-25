// /api/admin/nav_settings
//
//   GET   tenant's per-role navigation visibility:
//           { nav_disabled: { "<role>": ["<nav_id>", ...] } }
//   PATCH replace the whole map (admin chooses which left-nav items are
//         activated per role). Body: { nav_disabled: { role: [ids] } }.
//
//   GET is read-level (any authenticated user can learn what is hidden for
//   their own role, since the client needs it to render the sidebar);
//   PATCH is approve-level (only admins/managers change global config).
//
// We store the DISABLED set so new nav items ship visible by default. Core
// ids (home, admin) can never be disabled - that would lock an admin out of
// the very screen used to change this setting.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

// The roles the visibility map may key on. Mirrors ROLES in
// src/v3-app/lib/rbac.ts.
const KNOWN_ROLES = new Set([
  "sales_engineer", "sales_manager", "procurement",
  "finance", "admin", "operator", "viewer",
]);

// Items that must stay reachable for every role regardless of config.
const CORE_IDS = new Set(["home", "admin"]);

// nav ids are slugs; we don't hard-pin the full catalogue here (it lives in
// the frontend nav.ts and evolves), but we keep them well-formed so junk
// can't accumulate. An unknown id in the map is harmless - it simply has no
// matching sidebar item - but a malformed value would be a client bug.
const isNavId = (s) => typeof s === "string" && /^[a-z0-9-]{1,64}$/.test(s);

// Validate + normalize the incoming map. Returns { value } or { error }.
// Exported for unit tests.
export const normalizeMap = (raw) => {
  if (raw == null) return { value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "nav_disabled must be an object { role: [nav_id, ...] }" };
  }
  const out = {};
  for (const [role, ids] of Object.entries(raw)) {
    if (!KNOWN_ROLES.has(role)) return { error: "unknown role in nav_disabled: " + role };
    if (!Array.isArray(ids)) return { error: "nav_disabled[" + role + "] must be an array" };
    const seen = new Set();
    for (const id of ids) {
      if (!isNavId(id)) return { error: "invalid nav id in nav_disabled[" + role + "]: " + id };
      if (CORE_IDS.has(id)) continue; // never persist a core id as disabled
      seen.add(id);
    }
    if (seen.size) out[role] = Array.from(seen).sort();
  }
  return { value: out };
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
      const map = settings?.nav_disabled && typeof settings.nav_disabled === "object" && !Array.isArray(settings.nav_disabled)
        ? settings.nav_disabled
        : {};
      return json(res, 200, { nav_disabled: map });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return json(res, 400, { error: { message: "body must be an object" } });
      }
      if (!Object.prototype.hasOwnProperty.call(body, "nav_disabled")) {
        return json(res, 400, { error: { message: "body must include nav_disabled" } });
      }
      const { value, error } = normalizeMap(body.nav_disabled);
      if (error) return json(res, 400, { error: { message: error } });

      const next = await updateTenantSettings(svc, ctx.tenantId, { nav_disabled: value });
      await recordAudit(ctx, {
        action: "nav_settings_updated",
        objectType: "tenant",
        objectId: ctx.tenantId,
        detail: Object.keys(value).join(","),
        after: value,
      });
      return json(res, 200, { ok: true, nav_disabled: next?.nav_disabled || value });
    }

    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
