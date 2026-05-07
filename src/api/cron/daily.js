// GET /api/cron/daily
//
// Runs once per day. Fans out to the four daily aggregations:
//   - analytics/refresh   (win/loss rollups)
//   - fx/cron             (currency rates)
//   - service/amc_cron    (AMC contract reminders)
//   - rlhf/aggregate      (RLHF reward rollups)
//
// Sequenced (not parallel) because they're independent and not
// time-sensitive. Per-handler try/catch via runCronGroup so one
// failure does not block the rest.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { runCronGroup, recordCronHeartbeat } from "../_lib/cron-mux.js";

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
    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: durationMs,
      results,
    });
  } catch (err) {
    await recordCronHeartbeat("cron/daily", { status: "error", metadata: { error: String(err.message || err).slice(0, 200) } });
    sendError(res, err);
  }
}
