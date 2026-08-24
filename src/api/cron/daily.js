// GET /api/cron/daily
//
// Runs once per day. Fans out to the four daily aggregations:
//   - analytics/refresh   (win/loss rollups)
//   - fx/cron             (currency rates)
//   - service/amc_cron    (AMC contract reminders)
//   - rlhf/aggregate      (RLHF reward rollups)
//
// runCronGroup fans these out in PARALLEL (Promise.allSettled) with a
// per-handler timeout, so one slow or failing handler neither blocks nor
// starves the rest.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { runCronGroup, recordCronHeartbeat } from "../_lib/cron-mux.js";
import { probeCronFreshness, emitStaleCronAlert } from "../_lib/heartbeat-check.js";

import analyticsRefresh from "../analytics/refresh.js";
import fxCron           from "../fx/cron.js";
import amcCron          from "../service/amc_cron.js";
import rlhfAggregate    from "../rlhf/aggregate.js";
// Audit P6.5: daily quote-expiry cron.
import quotesExpire     from "../quotes/expire.js";
// Audit P7.6: daily recurring-invoice generation.
import recurringCron    from "../billing/recurring_cron.js";
// Audit P7.7: daily e-Way bill expiry sweep.
import ewayExpire       from "../eway_bills/expire.js";
// Audit P8.4: daily catalog embedding indexer.
import catalogEmbed     from "../catalog/embed.js";
// Bet 5: monthly drift report. Runs every day; the handler
// short-circuits on days other than the 1st of the month.
import driftReportCron  from "./drift-report.js";
// CM P4: daily extraction-quality alert (DPMO breach → admin bell). Cheap DB
// reads; self-guards on sample size + a 24h dedup. Disable via
// EVAL_QUALITY_ALERT_DISABLED.
import evalQualityAlert from "./eval_quality_alert.js";
import extractionReaper from "./extraction_reaper.js";
// CM P4: live-model replay of the golden corpus. OPT-IN + cost-bounded — only
// scheduled when EVAL_REPLAY_ENABLED is set (it burns real LLM calls). Gets a
// wide per-handler timeout since each case re-runs the model.
import evalReplay       from "../eval/replay.js";
// Logistics monitor. Also registered in tick.js's 5-min ALWAYS group — but that
// group only runs if the EXTERNAL cron-job.org trigger is configured and live,
// because Vercel's Hobby tier rejects any sub-daily schedule (docs/CRONS.md) and
// vercel.json therefore schedules nothing but this daily path. So the 5-min
// cadence is best-effort and this is the only Vercel-native guarantee the
// monitor runs at all. Idempotent — the detector dedups per (tenant, kind,
// object) and notifications track detail.notified — so running it on both paths
// costs a no-op, and no tenant has it on unless logistics_monitor_enabled.
import logisticsMonitor from "./logistics-monitor-tick.js";
// The nightly forecast snapshot. /api/forecast's own header says the dashboard
// "reads from the nightly forecast_snapshots table" — but nothing scheduled it,
// so the table only advanced when an admin clicked, and the cockpit's weighted
// pipeline was as old as the last click with nothing on screen saying so.
import forecastSnapshot from "../forecast/index.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!CRON_SECRET || auth !== CRON_SECRET) {
      return json(res, 401, { error: { message: "daily is cron-only" } });
    }
    const startedAt = new Date();
    const results = await runCronGroup([
      { name: "analytics/refresh", fn: analyticsRefresh, opts: { path: "/api/analytics/refresh" } },
      { name: "fx/cron",           fn: fxCron,           opts: { path: "/api/fx/cron" } },
      { name: "service/amc_cron",  fn: amcCron,          opts: { path: "/api/service/amc_cron" } },
      { name: "rlhf/aggregate",    fn: rlhfAggregate,    opts: { path: "/api/rlhf/aggregate" } },
      { name: "quotes/expire",     fn: quotesExpire,     opts: { path: "/api/quotes/expire" } },
      { name: "billing/recurring", fn: recurringCron,    opts: { path: "/api/billing/recurring_cron" } },
      { name: "eway_bills/expire", fn: ewayExpire,       opts: { path: "/api/eway_bills/expire" } },
      { name: "catalog/embed",     fn: catalogEmbed,     opts: { path: "/api/catalog/embed" } },
      { name: "forecast/snapshot", fn: forecastSnapshot, opts: { path: "/api/forecast", method: "POST", body: {} } },
      // Bet 5: monthly drift-reconciliation report. Idempotent;
      // self-skips on non-month-start days.
      { name: "drift-report",      fn: driftReportCron,  opts: { path: "/api/cron/drift-report" } },
      // CM P4: extraction-quality alert — raises the admin bell when the
      // operator-corrected DPMO breaches threshold. Self-guards on sample size.
      { name: "eval/quality_alert", fn: evalQualityAlert, opts: { path: "/api/cron/eval_quality_alert" } },
      // Backstop for runs stranded at status='running' by a killed function.
      { name: "docai/extraction_reaper", fn: extractionReaper, opts: { path: "/api/cron/extraction_reaper" } },
      // Daily backstop for the logistics monitor. Registered under a name of its
      // OWN, not tick.js's "logistics/monitor": each name is a row in
      // cron_health, and reusing the 5-min row would refresh it once a day
      // against a 10-minute staleness bound — leaving it stale 23h50m out of
      // every 24h and holding /api/_healthz at 503. Worse, it would also mask a
      // dead external trigger by making the 5-min row look freshly written.
      { name: "logistics/monitor_daily", fn: logisticsMonitor, opts: { path: "/api/cron/logistics-monitor-tick" } },
      // CM P4: live-model replay — opt-in via EVAL_REPLAY_ENABLED. Wide timeout
      // because each golden case re-runs the model; the handler caps case count.
      ...(process.env.EVAL_REPLAY_ENABLED
        ? [{ name: "eval/replay", fn: evalReplay, opts: { path: "/api/eval/replay", method: "POST", body: {}, timeoutMs: 55000 } }]
        : []),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;
    const durationMs = Date.now() - startedAt.getTime();
    // Audit P5.1: heartbeat the daily aggregator + each sub-handler.
    await recordCronHeartbeat("cron/daily", {
      status: errCount === 0 ? "ok" : (okCount > 0 ? "partial" : "error"),
      durationMs,
      metadata: { total: results.length, ok: okCount, failed: errCount },
    });
    for (const r of results) {
      await recordCronHeartbeat(r.name, {
        status: r.ok ? "ok" : "error",
        durationMs: r.duration_ms || 0,
        metadata: r.error ? { error: String(r.error).slice(0, 200) } : { status: r.status },
      });
    }
    // F4: heartbeat-staleness sweep. Runs after the daily fan-out
    // because by then every same-day cron should have refreshed
    // its row. If the 5-minute tick is stale here (>10 minutes)
    // the external cron-job.org trigger has lapsed and the on-call
    // rotation needs to know. The alert emits to console.warn
    // today; Sentry / Pagerduty pipe these in production via the
    // Vercel log drain.
    const staleness = await probeCronFreshness().catch(() => null);
    const alert = staleness ? emitStaleCronAlert(staleness) : null;
    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: durationMs,
      results,
      staleness_check: staleness
        ? { any_stale: staleness.any_stale, stale_workers: staleness.stale_workers }
        : null,
      staleness_alert: alert,
    });
  } catch (err) {
    await recordCronHeartbeat("cron/daily", { status: "error", metadata: { error: String(err.message || err).slice(0, 200) } });
    sendError(res, err);
  }
}
