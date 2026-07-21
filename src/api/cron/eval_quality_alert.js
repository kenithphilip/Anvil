/* CM P4: extraction-quality alerting.
 *
 * Recomputes the operator-corrected defect rate (quality.js) per tenant over a
 * window and raises an admin-bell notification when DPMO breaches a threshold —
 * so a silent extraction-quality slide surfaces instead of only living on a
 * dashboard nobody's watching. Reuses computeExtractionQuality verbatim.
 *
 * Guards against noise: only alerts on a MEANINGFUL sample (min shipped runs +
 * min opportunities), and at most once per tenant per 24h while breached
 * (notifyAdmins' own dedup is a 5-minute flap window — too short for a daily
 * cron, so we add a 24h transition dedup here).
 *
 * Runs from the daily cron (Bearer CRON_SECRET → all tenants with recent
 * shipped runs); also callable by an authed admin for one tenant. Tunable via
 * EVAL_QUALITY_ALERT_DPMO / _WINDOW_DAYS / _MIN_RUNS / _MIN_OPPS; disable with
 * EVAL_QUALITY_ALERT_DISABLED.
 */

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computeExtractionQuality } from "../eval/quality.js";
import { notifyAdmins } from "../_lib/notifications.js";

const CRON_SECRET = process.env.CRON_SECRET;
const ALERT_KIND = "extraction_quality_alert";

const config = () => ({
  dpmoThreshold: Number(process.env.EVAL_QUALITY_ALERT_DPMO) || 6210,          // ~4σ
  windowDays: Number(process.env.EVAL_QUALITY_ALERT_WINDOW_DAYS) || 30,
  minShippedRuns: Number(process.env.EVAL_QUALITY_ALERT_MIN_RUNS) || 20,
  minOpportunities: Number(process.env.EVAL_QUALITY_ALERT_MIN_OPPS) || 200,
});

// Suppress a repeat alert if one is already unresolved in the last 24h.
const alertedRecently = async (svc, tenantId) => {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const q = await svc.from("admin_notifications")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("kind", ALERT_KIND)
    .eq("resolved", false)
    .gte("created_at", since)
    .limit(1);
  return Array.isArray(q.data) && q.data.length > 0;
};

// Evaluate + alert each tenant. Pure of req/res so it's unit-testable.
export const runQualityAlerts = async (svc, { tenants, config: cfg = config() } = {}) => {
  const results = [];
  for (const tenantId of (tenants || [])) {
    let q;
    try { q = await computeExtractionQuality(svc, { tenantId, days: cfg.windowDays }); }
    catch (e) { results.push({ tenant_id: tenantId, error: (e && e.message) || String(e) }); continue; }

    if (!q || !q.available) { results.push({ tenant_id: tenantId, skipped: "unavailable" }); continue; }
    if (q.shipped_runs < cfg.minShippedRuns || q.opportunities < cfg.minOpportunities) {
      results.push({ tenant_id: tenantId, skipped: "insufficient_sample", shipped_runs: q.shipped_runs, opportunities: q.opportunities });
      continue;
    }
    if (q.dpmo <= cfg.dpmoThreshold) {
      results.push({ tenant_id: tenantId, ok: true, dpmo: Math.round(q.dpmo), sigma: q.sigma });
      continue;
    }
    if (await alertedRecently(svc, tenantId)) {
      results.push({ tenant_id: tenantId, breach: true, deduped: true, dpmo: Math.round(q.dpmo) });
      continue;
    }
    const notified = await notifyAdmins(svc, tenantId, {
      kind: ALERT_KIND,
      title: "Extraction quality below target",
      body: "Operator-corrected defect rate is " + Math.round(q.dpmo).toLocaleString("en-IN") + " DPMO (~" + q.sigma + "σ) over the last " + q.window_days + "d — " + q.defects + " corrected fields across " + Number(q.opportunities).toLocaleString("en-IN") + " shipped opportunities. Alert threshold is " + cfg.dpmoThreshold.toLocaleString("en-IN") + " DPMO.",
      link_route: "evals",
      object_type: "eval_quality",
    }, { roles: ["admin"] });
    results.push({ tenant_id: tenantId, breach: true, notified: notified.notified || 0, dpmo: Math.round(q.dpmo), sigma: q.sigma });
  }
  return results;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (process.env.EVAL_QUALITY_ALERT_DISABLED) return json(res, 200, { skipped: "disabled" });
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    const cfg = config();

    let tenants;
    if (isCron) {
      // Every tenant with a recently-shipped extraction run.
      const since = new Date(Date.now() - cfg.windowDays * 86400000).toISOString();
      const tq = await svc.from("extraction_runs")
        .select("tenant_id")
        .eq("status", "ok")
        .gte("finished_at", since)
        .limit(20000);
      tenants = Array.from(new Set((tq.data || []).map((r) => r.tenant_id))).filter(Boolean);
    } else {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "read");
      tenants = [ctx.tenantId];
    }

    const results = await runQualityAlerts(svc, { tenants, config: cfg });
    return json(res, 200, {
      ran_at: new Date().toISOString(),
      tenants: tenants.length,
      threshold_dpmo: cfg.dpmoThreshold,
      breached: results.filter((r) => r.breach).length,
      notified: results.filter((r) => r.notified).length,
      results,
    });
  } catch (err) {
    sendError(res, err);
  }
}
