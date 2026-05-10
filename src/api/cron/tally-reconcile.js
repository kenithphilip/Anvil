// /api/cron/tally-reconcile
//
// Phase F.6 reconciliation cron. Walks every tenant with a
// configured Tally bridge + at least one exported voucher in the
// last 7 days, runs the drift check, persists findings, applies
// auto-fix when the tenant opted in.
//
// Runs every 30 min via /api/cron/tick (alongside tally/sync).
// Authentication is the standard CRON_SECRET pattern; admin
// users can also trigger manually.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { driftCheck } from "../_lib/tally-reconciler.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PER_TENANT_LIMIT = 50;        // cap per tick per tenant; reconciler also caps internally

const drainOnce = async (svc) => {
  // Find tenants with at least one exported voucher in the last 7 days
  // AND who have the Tally drift add-on enabled (Bet 5). The add-on
  // is the gating mechanism for paid SKU. Tenants without the add-on
  // can still hit the manual mark-status endpoint (the legacy v1
  // path); they just don't get cron-driven drift detection.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const tenantsResp = await svc.from("tally_voucher_records")
    .select("tenant_id")
    .eq("status", "exported")
    .gte("created_at", since);
  if (tenantsResp.error) throw new Error(tenantsResp.error.message);
  const candidateIds = Array.from(new Set((tenantsResp.data || []).map((r) => r.tenant_id)));

  // Filter the candidate list down to add-on-enabled tenants. Empty
  // result short-circuits cleanly.
  if (candidateIds.length === 0) return { tenants_processed: 0, runs: [], summary: {
    total_drifted: 0, total_clean: 0, total_auto_fixes: 0,
  } };
  const enabledResp = await svc.from("tenant_settings")
    .select("tenant_id")
    .in("tenant_id", candidateIds)
    .eq("tally_drift_addon_enabled", true);
  if (enabledResp.error) throw new Error(enabledResp.error.message);
  const tenantIds = (enabledResp.data || []).map((r) => r.tenant_id);

  const results = [];
  for (const tenantId of tenantIds) {
    try {
      const out = await driftCheck(svc, {
        tenantId,
        scope: "tenant_recent",
        trigger: "cron",
        triggeredBy: null,
        limit: PER_TENANT_LIMIT,
      });
      results.push({ tenant_id: tenantId, ...out });
    } catch (err) {
      results.push({ tenant_id: tenantId, error: err.message || String(err) });
    }
  }
  return {
    tenants_processed: tenantIds.length,
    runs: results,
    summary: {
      total_drifted: results.reduce((acc, r) => acc + (Number(r.vouchers_drifted) || 0), 0),
      total_clean: results.reduce((acc, r) => acc + (Number(r.vouchers_clean) || 0), 0),
      total_auto_fixes: results.reduce((acc, r) => acc + (Number(r.auto_fixes_applied) || 0), 0),
    },
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (isCron) {
      const out = await drainOnce(svc);
      return json(res, 200, { ran_at: new Date().toISOString(), ...out });
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drainOnce(svc);
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
