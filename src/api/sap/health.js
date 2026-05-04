// GET /api/sap/health

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sapDecryptCreds, sapIsConfigured } from "../_lib/sap-client.js";
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
    const settings = sapDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    const [stateQ, runsQ, queuedQ, gaveUpQ] = await Promise.all([
      svc.from("sap_sync_state").select("*").eq("tenant_id", ctx.tenantId),
      svc.from("sap_sync_runs").select("*").eq("tenant_id", ctx.tenantId).order("run_started_at", { ascending: false }).limit(20),
      svc.from("sap_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "pending"),
      svc.from("sap_retry_queue").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "gave_up"),
    ]);
    const storage = (settingsRaw?.sap_client_id_enc && settingsRaw?.sap_creds_iv)
      ? "encrypted" : (settingsRaw?.sap_client_id ? "plaintext" : "none");
    return json(res, 200, {
      configured: sapIsConfigured(settings),
      base_url: settingsRaw?.sap_base_url || null,
      token_url: settingsRaw?.sap_token_url || null,
      sales_org: settingsRaw?.sap_sales_org || null,
      connected_at: settingsRaw?.sap_connected_at || null,
      last_full_sync_at: settingsRaw?.sap_last_full_sync_at || null,
      storage_mode: storage,
      secrets_key_present: isSecretsConfigured(),
      sync_state: stateQ.data || [],
      recent_runs: runsQ.data || [],
      retry_pending: queuedQ.count || 0,
      retry_gave_up: gaveUpQ.count || 0,
      field_map: settingsRaw?.sap_field_map || {},
    });
  } catch (err) { sendError(res, err); }
}
