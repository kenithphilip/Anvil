// GET /api/cron/conformal-calibration-weekly
//
// Weekly cron (default Sunday 14:00 IST, 12 hours before the
// planning cron). Per tenant + per planning-enabled part:
//
//   1. Walk last 156 weeks of order_schedule_lines + last
//      demand_forecasts. Build per-(part, week) actual-vs-forecast
//      pairs.
//   2. Upsert into conformal_calibration_residuals so the planning
//      cron has fresh residuals to read.
//   3. Prune any rows older than 156 weeks (the NEXCP weight
//      decay below rho^156 = 0.21 is too small to matter).
//
// Idempotent on second run via the (tenant_id, part_no,
// week_start) unique key on the residuals table.
//
// Bet 3 companion to inventory-planning-weekly.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordCronHeartbeat } from "../_lib/cron-mux.js";
import { isoWeekStart } from "../_lib/inventory/pipeline-demand.js";
import { addWeeks } from "../_lib/inventory/net-req.js";

const CRON_SECRET = process.env.CRON_SECRET;
const HISTORY_WEEKS = 156;       // ~3 years; matches the schema doc
const PRUNE_OLDER_THAN_WEEKS = 156;

const calibrateTenant = async (svc, tenantId) => {
  const settings = await svc.from("tenant_settings")
    .select("inventory_conformal_enabled, inventory_planning_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!settings.data) return { tenant_id: tenantId, skipped: "no_settings" };
  if (!settings.data.inventory_conformal_enabled) {
    return { tenant_id: tenantId, skipped: "conformal_disabled" };
  }

  const items = await svc.from("item_master")
    .select("part_no")
    .eq("tenant_id", tenantId)
    .eq("planning_enabled", true);
  const parts = (items.data || []).map((i) => i.part_no);
  if (!parts.length) return { tenant_id: tenantId, parts: 0 };

  // 1. Build actuals per (part, week) from shipped order schedule
  // lines over the trailing window.
  const sinceISO = addWeeks(isoWeekStart(new Date()), -HISTORY_WEEKS);
  const actuals = new Map();   // key = part:weekKey -> qty
  let pageOffset = 0;
  // Pagination loop so we don't pull all parts into one query.
  // Supabase caps single responses around 1000 rows; we chunk parts.
  for (let i = 0; i < parts.length; i += 50) {
    const chunk = parts.slice(i, i + 50);
    const sched = await svc.from("order_schedule_lines")
      .select("part_no, scheduled_qty, scheduled_date")
      .eq("tenant_id", tenantId)
      .gte("scheduled_date", sinceISO)
      .in("part_no", chunk);
    if (sched.error) throw new Error("sched: " + sched.error.message);
    for (const row of (sched.data || [])) {
      const wk = isoWeekStart(row.scheduled_date);
      if (!wk) continue;
      const key = row.part_no + ":" + wk;
      actuals.set(key, (actuals.get(key) || 0) + (Number(row.scheduled_qty) || 0));
    }
  }
  void pageOffset;

  // 2. Pull the most recent forecast per (part, week) so we can
  // diff actual - forecast. The forecast row is keyed by
  // (tenant, part, week, model_name); we take the latest by
  // generated_at.
  const forecasts = new Map(); // key = part:week -> forecast value
  for (let i = 0; i < parts.length; i += 50) {
    const chunk = parts.slice(i, i + 50);
    const fc = await svc.from("demand_forecasts")
      .select("part_no, week_start, forecast_baseline, generated_at")
      .eq("tenant_id", tenantId)
      .in("part_no", chunk)
      .gte("week_start", sinceISO)
      .order("generated_at", { ascending: true });
    if (fc.error) throw new Error("forecasts: " + fc.error.message);
    for (const row of (fc.data || [])) {
      // Last-write-wins per (part, week) because we sorted asc.
      const key = row.part_no + ":" + row.week_start;
      forecasts.set(key, Number(row.forecast_baseline) || 0);
    }
  }

  // 3. Upsert residuals. Only emit a row when we have BOTH an
  // actual and a forecast for the (part, week) pair; otherwise we
  // can't compute a residual.
  const upserts = [];
  for (const [key, actual] of actuals.entries()) {
    if (!forecasts.has(key)) continue;
    const [part_no, week] = key.split(":");
    upserts.push({
      tenant_id: tenantId,
      part_no,
      week_start: week,
      forecast_value: forecasts.get(key),
      actual_value: actual,
      weight: 1.0,
    });
  }

  // Chunk the upsert into 500-row batches to stay inside Supabase's
  // default rate / payload caps.
  let upserted = 0;
  for (let i = 0; i < upserts.length; i += 500) {
    const slice = upserts.slice(i, i + 500);
    const up = await svc.from("conformal_calibration_residuals").upsert(
      slice, { onConflict: "tenant_id,part_no,week_start" },
    );
    if (up.error) throw new Error("ccr/upsert: " + up.error.message);
    upserted += slice.length;
  }

  // 4. Prune rows older than the retention window.
  const cutoff = addWeeks(isoWeekStart(new Date()), -PRUNE_OLDER_THAN_WEEKS);
  const pruned = await svc.from("conformal_calibration_residuals")
    .delete()
    .eq("tenant_id", tenantId)
    .lt("week_start", cutoff);
  void pruned;

  return {
    tenant_id: tenantId,
    parts: parts.length,
    actuals_seen: actuals.size,
    forecasts_seen: forecasts.size,
    residuals_upserted: upserted,
  };
};

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
      .eq("inventory_conformal_enabled", true);
    if (tenants.error) throw new Error("tenants: " + tenants.error.message);
    const summaries = [];
    for (const row of (tenants.data || [])) {
      try {
        summaries.push(await calibrateTenant(svc, row.tenant_id));
      } catch (err) {
        summaries.push({
          tenant_id: row.tenant_id,
          error: String(err?.message || err).slice(0, 400),
        });
      }
    }
    await recordCronHeartbeat("conformal-calibration-weekly", {
      status: summaries.every((s) => !s.error) ? "ok" : "partial_failure",
      durationMs: Date.now() - t0,
      metadata: { tenants: summaries.length },
    });
    return json(res, 200, { ok: true, tenants: summaries });
  } catch (err) {
    await recordCronHeartbeat("conformal-calibration-weekly", {
      status: "failed",
      durationMs: Date.now() - t0,
      metadata: { error: String(err?.message || err).slice(0, 400) },
    });
    sendError(res, err);
  }
}
