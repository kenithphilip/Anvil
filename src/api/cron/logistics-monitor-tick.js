// GET /api/cron/logistics-monitor-tick
//
// Logistics monitor tick. Walks every tenant with
// logistics_monitor_enabled = true and, per tenant:
//   1. detectAllLogistics  — reuse delays/scan rules with the tenant's
//      configured SLAs; persist idempotent, fingerprint-deduped exceptions.
//   2. markBreaches        — flip open exceptions whose SLA target passed.
//   3. dispatchLogisticsNotifications — bell + email to escalate_roles, plus a
//      distinct SLA-breach escalation.
// Idempotent: the detector dedups per (tenant, kind, object) and notifications
// track detail.notified so re-runs don't spam.
//
// Registered in src/api/cron/tick.js (5-min ALWAYS group). NOTE: the 5-min
// tick is driven by the external cron-job.org trigger (vercel.json only
// schedules /api/cron/daily), so this must also be present in that scheduler.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordCronHeartbeat } from "../_lib/cron-mux.js";
import { detectAllLogistics, markBreaches } from "../_lib/logistics/monitor.js";
import { dispatchLogisticsNotifications } from "../_lib/logistics/notifications.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
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
    const tenants = await svc.from("tenant_settings")
      .select("tenant_id")
      .eq("logistics_monitor_enabled", true);
    if (tenants.error) throw new Error("tenants: " + tenants.error.message);

    const summaries = [];
    for (const row of (tenants.data || [])) {
      try {
        const detection = await detectAllLogistics(svc, row.tenant_id);
        const breaches = await markBreaches(svc, row.tenant_id);
        const notif = await dispatchLogisticsNotifications(svc, row.tenant_id);
        summaries.push({ ...detection, breached: breaches.breached, notifications: notif });
      } catch (err) {
        summaries.push({ tenant_id: row.tenant_id, error: String(err?.message || err).slice(0, 400) });
      }
    }

    await recordCronHeartbeat("logistics-monitor-tick", {
      status: summaries.every((s) => !s.error) ? "ok" : "partial_failure",
      durationMs: Date.now() - t0,
      metadata: { tenant_count: summaries.length },
    });
    return json(res, 200, { ok: true, tenants: summaries });
  } catch (err) {
    await recordCronHeartbeat("logistics-monitor-tick", {
      status: "failed",
      durationMs: Date.now() - t0,
      metadata: { error: String(err?.message || err).slice(0, 400) },
    });
    sendError(res, err);
  }
}
