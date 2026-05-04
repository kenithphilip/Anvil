import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { d365DecryptCreds, d365IsConfigured } from "../_lib/d365-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: { message: "Method not allowed" } }); }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = d365DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    const [stateQ, runsQ, queuedQ, gaveUpQ] = await Promise.all([
      svc.from("d365_sync_state").select("*").eq("tenant_id", ctx.tenantId),
      svc.from("d365_sync_runs").select("*").eq("tenant_id", ctx.tenantId).order("run_started_at", { ascending: false }).limit(20),
      svc.from("d365_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "pending"),
      svc.from("d365_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "gave_up"),
    ]);
    const storage = (settingsRaw?.d365_client_id_enc && settingsRaw?.d365_creds_iv) ? "encrypted"
      : (settingsRaw?.d365_client_id ? "plaintext" : "none");
    return json(res, 200, {
      configured: d365IsConfigured(settings),
      resource_url: settingsRaw?.d365_resource_url || null,
      tenant_id: settingsRaw?.d365_tenant_id || null,
      company: settingsRaw?.d365_company || null,
      connected_at: settingsRaw?.d365_connected_at || null,
      storage_mode: storage,
      secrets_key_present: isSecretsConfigured(),
      sync_state: stateQ.data || [],
      recent_runs: runsQ.data || [],
      retry_pending: queuedQ.count || 0,
      retry_gave_up: gaveUpQ.count || 0,
      field_map: settingsRaw?.d365_field_map || {},
    });
  } catch (err) { sendError(res, err); }
}
