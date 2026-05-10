// GET /api/cron/inventory-exceptions-tick
//
// Real-time exception tick. Runs every 30 minutes via cron-job.org
// (Vercel cron is rate-limited per the existing cron infra). Walks
// every tenant with inventory_planning_enabled = true and fans the
// exception detectors out per-tenant. The detectors are idempotent:
// each emits at most one open exception per (tenant, part, kind, day)
// thanks to the fingerprint-based dedup in
// _lib/inventory/exceptions-detector.js.
//
// On every tick we ALSO call the notifications dispatcher so that
// new critical exceptions push to the bell + email + (rate-limited)
// voice. See _lib/inventory/notifications.js.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordCronHeartbeat } from "../_lib/cron-mux.js";
import { detectAllExceptions } from "../_lib/inventory/exceptions-detector.js";
import { dispatchNotifications } from "../_lib/inventory/notifications.js";

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
      .eq("inventory_planning_enabled", true);
    if (tenants.error) throw new Error("tenants: " + tenants.error.message);
    const summaries = [];
    for (const row of (tenants.data || [])) {
      try {
        const detection = await detectAllExceptions(svc, row.tenant_id);
        const notif = await dispatchNotifications(svc, row.tenant_id);
        summaries.push({ ...detection, notifications: notif });
      } catch (err) {
        summaries.push({
          tenant_id: row.tenant_id,
          error: String(err?.message || err).slice(0, 400),
        });
      }
    }
    await recordCronHeartbeat("inventory-exceptions-tick", {
      status: summaries.every((s) => !s.error) ? "ok" : "partial_failure",
      durationMs: Date.now() - t0,
      metadata: { tenant_count: summaries.length },
    });
    return json(res, 200, { ok: true, tenants: summaries });
  } catch (err) {
    await recordCronHeartbeat("inventory-exceptions-tick", {
      status: "failed",
      durationMs: Date.now() - t0,
      metadata: { error: String(err?.message || err).slice(0, 400) },
    });
    sendError(res, err);
  }
}
