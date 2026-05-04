// GET /api/netsuite/health
//
// Reports the per-tenant NetSuite state: configured (credentials set),
// last_connected_at, latest sync state per entity, retry queue size,
// last 10 sync runs, and credential storage mode.
//
// The Admin Center reads this to render the connection banner +
// entity table + retry-queue widget. Anyone with `read` permission
// can read it; mutating operations remain admin-only.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { netsuiteIsConfigured } from "../_lib/netsuite-client.js";
import { decryptNetsuiteCreds, isSecretsConfigured } from "../_lib/secrets.js";

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
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = decryptNetsuiteCreds(settingsRaw);

    const [stateQ, runsQ, queuedQ, gaveUpQ] = await Promise.all([
      svc.from("netsuite_sync_state")
        .select("entity, last_sync_at, status, rows_pulled, records_inserted, records_updated, records_errored, last_modified_high_water, last_full_sync_at, error, updated_at")
        .eq("tenant_id", ctx.tenantId),
      svc.from("netsuite_sync_runs")
        .select("entity, status, run_started_at, run_finished_at, rows_pulled, rows_inserted, rows_updated, rows_errored, triggered_by, error")
        .eq("tenant_id", ctx.tenantId)
        .order("run_started_at", { ascending: false })
        .limit(20),
      svc.from("netsuite_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "pending"),
      svc.from("netsuite_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "gave_up"),
    ]);

    const storage = (settingsRaw?.netsuite_consumer_key_enc && settingsRaw?.netsuite_creds_iv)
      ? "encrypted"
      : (settingsRaw?.netsuite_consumer_key ? "plaintext" : "none");

    return json(res, 200, {
      configured: netsuiteIsConfigured(settings),
      account_id: settingsRaw?.netsuite_account_id || null,
      subsidiary_id: settingsRaw?.netsuite_subsidiary_id || null,
      default_location_id: settingsRaw?.netsuite_default_location_id || null,
      connected_at: settingsRaw?.netsuite_connected_at || null,
      last_full_sync_at: settingsRaw?.netsuite_last_full_sync_at || null,
      storage_mode: storage,
      secrets_key_present: isSecretsConfigured(),
      sync_state: stateQ.data || [],
      recent_runs: runsQ.data || [],
      retry_pending: queuedQ.count || 0,
      retry_gave_up: gaveUpQ.count || 0,
      field_map: settingsRaw?.netsuite_field_map || {},
    });
  } catch (err) {
    sendError(res, err);
  }
}
