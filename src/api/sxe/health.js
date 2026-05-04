import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sxeDecryptCreds, sxeIsConfigured } from "../_lib/sxe-client.js";
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
    const settings = sxeDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    const [stateQ, runsQ, queuedQ, gaveUpQ] = await Promise.all([
      svc.from("sxe_sync_state").select("*").eq("tenant_id", ctx.tenantId),
      svc.from("sxe_sync_runs").select("*").eq("tenant_id", ctx.tenantId).order("run_started_at", { ascending: false }).limit(20),
      svc.from("sxe_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "pending"),
      svc.from("sxe_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "gave_up"),
    ]);
    const storage = (settingsRaw?.sxe_client_id_enc && settingsRaw?.sxe_creds_iv) ? "encrypted"
      : (settingsRaw?.sxe_client_id ? "plaintext" : "none");
    return json(res, 200, {
      configured: sxeIsConfigured(settings),
      base_url: settingsRaw?.sxe_base_url || null,
      token_url: settingsRaw?.sxe_token_url || null,
      company: settingsRaw?.sxe_company || null,
      default_warehouse: settingsRaw?.sxe_default_warehouse || null,
      connected_at: settingsRaw?.sxe_connected_at || null,
      storage_mode: storage,
      secrets_key_present: isSecretsConfigured(),
      sync_state: stateQ.data || [],
      recent_runs: runsQ.data || [],
      retry_pending: queuedQ.count || 0,
      retry_gave_up: gaveUpQ.count || 0,
      field_map: settingsRaw?.sxe_field_map || {},
    });
  } catch (err) { sendError(res, err); }
}
