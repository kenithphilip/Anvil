// /api/plm/health
//   GET   summary of every PLM system + last sync + recent error
//
// Phase 5.5. Used by the Admin Center status panel.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const { data: systems } = await svc.from("plm_systems")
      .select("id, system, base_url, display_name, active, connected_at, last_error, updated_at")
      .eq("tenant_id", ctx.tenantId);
    const { data: states } = await svc.from("plm_sync_state")
      .select("system_id, entity, last_sync_at, status, last_error, rows_pulled")
      .eq("tenant_id", ctx.tenantId);
    return json(res, 200, {
      systems: systems || [],
      sync_state: states || [],
    });
  } catch (err) {
    return sendError(res, err);
  }
}
