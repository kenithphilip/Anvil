// /api/jde/health
//   GET   probe + sync state for the calling tenant's JDE setup.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { jdeDecryptCreds, jdeIsConfigured, jdeProbe } from "../_lib/jde-client.js";

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
    const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!sRow.data) return json(res, 200, { configured: false });
    const settings = jdeDecryptCreds({ ...sRow.data, tenant_id: ctx.tenantId });
    const configured = jdeIsConfigured(settings);
    let probeOk = null;
    let probeError = null;
    if (configured) {
      try {
        const r = await jdeProbe(settings);
        probeOk = r.ok;
        if (!r.ok) probeError = JSON.stringify(r.body).slice(0, 400);
      } catch (err) {
        probeOk = false;
        probeError = err.message;
      }
    }
    const { data: state } = await svc.from("jde_sync_state")
      .select("*").eq("tenant_id", ctx.tenantId);
    const { data: retryDue } = await svc.from("jde_retry_queue")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).eq("status", "pending");
    return json(res, 200, {
      configured,
      probe_ok: probeOk,
      probe_error: probeError,
      base_url: settings.jde_base_url || null,
      environment: settings.jde_environment || null,
      connected_at: settings.jde_connected_at || null,
      sync_state: state || [],
      retry_pending: retryDue?.length || 0,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
