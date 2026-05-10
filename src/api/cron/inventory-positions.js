// GET /api/cron/inventory-positions
//
// Daily (or sub-daily) cron that refreshes the per-source +
// reconciled `inventory_positions` rows from the ERP-mirror tables.
// Idempotent: re-running just upserts.
//
// Triggered by Vercel cron / cron-job.org. Authed via CRON_SECRET.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordCronHeartbeat } from "../_lib/cron-mux.js";
import { refreshPositions } from "../_lib/inventory/positions.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  // Cron auth gate.
  if (CRON_SECRET) {
    const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
                  || req.headers["x-cron-secret"]
                  || "";
    if (provided !== CRON_SECRET) {
      return json(res, 401, { error: { message: "Cron auth required" } });
    }
  }
  const t0 = Date.now();
  try {
    const svc = serviceClient();
    // Fan out across every tenant that has inventory_planning_enabled.
    const tenants = await svc.from("tenant_settings")
      .select("tenant_id")
      .eq("inventory_planning_enabled", true);
    if (tenants.error) throw new Error("tenants: " + tenants.error.message);
    const summaries = [];
    for (const row of (tenants.data || [])) {
      try {
        const r = await refreshPositions(svc, row.tenant_id);
        summaries.push({ tenant_id: row.tenant_id, ...r });
      } catch (err) {
        summaries.push({
          tenant_id: row.tenant_id,
          error: String(err?.message || err).slice(0, 400),
        });
      }
    }
    await recordCronHeartbeat("inventory-positions", {
      status: summaries.every((s) => !s.error) ? "ok" : "partial_failure",
      durationMs: Date.now() - t0,
      metadata: { tenant_count: summaries.length },
    });
    return json(res, 200, { ok: true, tenants: summaries });
  } catch (err) {
    await recordCronHeartbeat("inventory-positions", {
      status: "failed",
      durationMs: Date.now() - t0,
      metadata: { error: String(err?.message || err).slice(0, 400) },
    });
    sendError(res, err);
  }
}
