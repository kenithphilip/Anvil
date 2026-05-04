// GET /api/netsuite/health
//
// Reports the per-tenant NetSuite state: configured (credentials set),
// last_connected_at, latest sync state per entity. The Admin Center
// reads this to render the connection banner + entity table.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { netsuiteIsConfigured } from "../_lib/netsuite-client.js";

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
    const settings = await tenantSettings(svc, ctx.tenantId);
    const stateQ = await svc
      .from("netsuite_sync_state")
      .select("entity, last_sync_at, status, rows_pulled, error, updated_at")
      .eq("tenant_id", ctx.tenantId);
    return json(res, 200, {
      configured: netsuiteIsConfigured(settings),
      account_id: settings?.netsuite_account_id || null,
      connected_at: settings?.netsuite_connected_at || null,
      sync_state: stateQ.data || [],
    });
  } catch (err) {
    sendError(res, err);
  }
}
