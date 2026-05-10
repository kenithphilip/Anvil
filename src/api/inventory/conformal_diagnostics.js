// GET  /api/inventory/conformal_diagnostics
// GET  /api/inventory/conformal_diagnostics?part_no=ATD-1
// PATCH /api/inventory/conformal_diagnostics?part_no=ATD-1
//   body: { conformal_coverage: 0.95, conformal_method_override: 'nexcp' | 'split_cp' | null }
//
// Diagnostics endpoint for Bet 3. Two responsibilities:
//
//   1. (GET, no part_no) Tenant-wide rollup:
//        - tenant settings (enabled flag, default coverage,
//          tenant-level method preference)
//        - count of SKUs by CP method bucket
//          (nexcp / split_cp / pooled_cold_start / parametric_legacy)
//        - cohort residual counts per item_type
//        - empirical coverage over the last 13 weeks: how often did
//          the actual fall inside the stamped interval. The "Coverage
//          drift" alert fires when realised < target by > 5%.
//
//   2. (GET, with part_no) Per-SKU detail: residuals, the latest
//      forecast row's interval, the empirical-coverage trend, and
//      the cohort that would be used for cold-start.
//
//   3. (PATCH, with part_no) Operator override of the per-SKU
//      conformal_coverage and conformal_method_override on
//      item_master. RBAC: "admin" (matches admin/item_master.js).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { empiricalCoverage } from "../_lib/inventory/conformal.js";

const ALLOWED_METHODS = new Set(["nexcp", "split_cp"]);

const validateCoverage = (v) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("conformal_coverage must be numeric");
  if (n <= 0.5 || n >= 1) throw new Error("conformal_coverage must be in (0.5, 1)");
  return n;
};

const validateMethod = (m) => {
  if (m == null || m === "") return null;
  if (!ALLOWED_METHODS.has(m)) throw new Error("conformal_method_override must be nexcp or split_cp");
  return m;
};

// Pull the last N forecast rows for a (part, window) tuple and the
// matching actuals from order_schedule_lines so we can compute
// empirical coverage. Returns the merged sample array suitable for
// empiricalCoverage().
const buildCoverageSamples = async (svc, tenantId, partNo, weeks = 13) => {
  const today = new Date();
  const since = new Date(today.getTime() - weeks * 7 * 86400_000)
    .toISOString().slice(0, 10);
  // We use the stamped interval_lo/hi on demand_forecasts to compare
  // against the actual qty from order_schedule_lines for the same
  // week. demand_forecasts is keyed by (part, week, model); we pick
  // the most recent generated_at per (part, week).
  const fc = await svc.from("demand_forecasts")
    .select("part_no, week_start, interval_lo, interval_hi, generated_at")
    .eq("tenant_id", tenantId)
    .eq(partNo ? "part_no" : "tenant_id", partNo || tenantId)
    .gte("week_start", since)
    .order("generated_at", { ascending: true });
  if (fc.error) throw new Error(fc.error.message);
  const fcByKey = new Map();
  for (const row of (fc.data || [])) {
    if (row.interval_lo == null || row.interval_hi == null) continue;
    fcByKey.set(row.part_no + ":" + row.week_start, {
      interval_lo: Number(row.interval_lo),
      interval_hi: Number(row.interval_hi),
    });
  }
  const partFilter = partNo ? { part_no: partNo } : null;
  let q = svc.from("order_schedule_lines")
    .select("part_no, scheduled_qty, scheduled_date")
    .eq("tenant_id", tenantId)
    .gte("scheduled_date", since);
  if (partFilter) q = q.eq("part_no", partFilter.part_no);
  const sched = await q;
  if (sched.error) throw new Error(sched.error.message);
  // Bucket actuals per (part, week_start_iso) similar to history
  // assembly in the planning cron.
  const actuals = new Map();
  for (const row of (sched.data || [])) {
    const wk = (row.scheduled_date || "").slice(0, 10);
    if (!wk) continue;
    const key = row.part_no + ":" + wk;
    actuals.set(key, (actuals.get(key) || 0) + (Number(row.scheduled_qty) || 0));
  }
  const samples = [];
  for (const [key, actual] of actuals.entries()) {
    const band = fcByKey.get(key);
    if (!band) continue;
    samples.push({
      part_no: key.split(":")[0],
      week_start: key.split(":")[1],
      interval_lo: band.interval_lo,
      interval_hi: band.interval_hi,
      actual,
    });
  }
  return samples;
};

const handleGet = async (svc, ctx, partNo) => {
  const settings = await svc.from("tenant_settings")
    .select("inventory_conformal_enabled, inventory_conformal_default_coverage, inventory_conformal_method")
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (partNo) {
    // Per-SKU view.
    const item = await svc.from("item_master")
      .select("part_no, item_type, service_level, conformal_coverage, conformal_method_override, demand_class, safety_stock, reorder_point")
      .eq("tenant_id", ctx.tenantId)
      .eq("part_no", partNo)
      .maybeSingle();
    const residuals = await svc.from("conformal_calibration_residuals")
      .select("week_start, forecast_value, actual_value, residual, weight")
      .eq("tenant_id", ctx.tenantId)
      .eq("part_no", partNo)
      .order("week_start", { ascending: true })
      .limit(156);
    const latestForecast = await svc.from("demand_forecasts")
      .select("week_start, conformal_method, coverage_target, interval_lo, interval_hi, calibration_residuals_count, quantile_50, quantile_95, generated_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("part_no", partNo)
      .order("generated_at", { ascending: false })
      .limit(12);
    const samples = await buildCoverageSamples(svc, ctx.tenantId, partNo, 13);
    const cov = empiricalCoverage(samples);
    return {
      part_no: partNo,
      item: item.data || null,
      tenant_default_coverage: Number(settings.data?.inventory_conformal_default_coverage) || 0.95,
      conformal_enabled: !!settings.data?.inventory_conformal_enabled,
      residuals: residuals.data || [],
      latest_forecast: (latestForecast.data || []).reverse(),
      empirical_coverage: cov,
      effective_coverage_target: Number(item.data?.conformal_coverage)
        || Number(item.data?.service_level)
        || Number(settings.data?.inventory_conformal_default_coverage)
        || 0.95,
    };
  }

  // Tenant-wide rollup.
  const recent = await svc.from("demand_forecasts")
    .select("part_no, conformal_method, calibration_residuals_count, generated_at")
    .eq("tenant_id", ctx.tenantId)
    .order("generated_at", { ascending: false })
    .limit(2000);
  const seen = new Set();
  const buckets = {};
  for (const row of (recent.data || [])) {
    if (seen.has(row.part_no)) continue;
    seen.add(row.part_no);
    const m = row.conformal_method || "unknown";
    buckets[m] = (buckets[m] || 0) + 1;
  }
  const cohorts = await svc.from("item_master")
    .select("part_no, item_type")
    .eq("tenant_id", ctx.tenantId);
  const cohortCounts = {};
  for (const r of (cohorts.data || [])) {
    const k = r.item_type || "OTHER";
    cohortCounts[k] = (cohortCounts[k] || 0) + 1;
  }
  const samples = await buildCoverageSamples(svc, ctx.tenantId, null, 13);
  const cov = empiricalCoverage(samples);
  const target = Number(settings.data?.inventory_conformal_default_coverage) || 0.95;
  const drift = (cov.coverage != null) ? target - cov.coverage : null;
  return {
    tenant_settings: {
      enabled: !!settings.data?.inventory_conformal_enabled,
      default_coverage: target,
      method: settings.data?.inventory_conformal_method || "nexcp",
    },
    method_buckets: buckets,
    cohort_counts: cohortCounts,
    empirical_coverage: cov,
    drift,
    drift_alert: (drift != null && drift > 0.05),
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const url = new URL(req.url, "http://_");
    const partNo = url.searchParams.get("part_no");
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const out = await handleGet(svc, ctx, partNo);
      return json(res, 200, out);
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "admin");
      if (!partNo) {
        return json(res, 400, { error: { message: "part_no required for PATCH" } });
      }
      const body = await readBody(req);
      const patch = {};
      if ("conformal_coverage" in body) {
        patch.conformal_coverage = validateCoverage(body.conformal_coverage);
      }
      if ("conformal_method_override" in body) {
        patch.conformal_method_override = validateMethod(body.conformal_method_override);
      }
      if (Object.keys(patch).length === 0) {
        return json(res, 400, {
          error: { message: "body must include conformal_coverage and/or conformal_method_override" },
        });
      }
      const upd = await svc.from("item_master")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("part_no", partNo)
        .select("part_no, conformal_coverage, conformal_method_override")
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.conformal.override",
        objectType: "item_master",
        objectId: null,
        detail: { part_no: partNo, patch },
      });
      return json(res, 200, { ok: true, item: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
