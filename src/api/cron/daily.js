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
import { runCronGroup } from "../_lib/cron-mux.js";

import analyticsRefresh from "../analytics/refresh.js";
import fxCron           from "../fx/cron.js";
import amcCron          from "../service/amc_cron.js";
import rlhfAggregate    from "../rlhf/aggregate.js";

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
    ]);
    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;
    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: Date.now() - startedAt.getTime(),
      results,
    });
  } catch (err) { sendError(res, err); }
}
