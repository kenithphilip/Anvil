// Shared cron-heartbeat staleness check (Phase 1 F4).
//
// One source of truth so /api/health, the new /api/_healthz, and
// the cron/daily post-run sweep agree on what counts as stale.
// The 5-minute /api/cron/tick is the most critical worker: if it
// stops firing, every sub-handler under it (push notifications,
// 17 ERP retry queues, inbound email parse, tally retry,
// per-tenant agent runs) silently stops, and the operator sees
// nothing until customers report missing notifications.
//
// Cadence map. Values are the latest-acceptable age before we
// flag the worker as stale. Tick gets a 10-minute bound (2x its
// 5-min cadence + 50% grace). Sub-handlers either inherit or get
// looser bounds because they only fire on certain minutes.

import { serviceClient } from "./supabase.js";
import { notifyAdmins } from "./notifications.js";

export const CRON_EXPECTED_MAX_AGE_MS = {
  "cron/tick":            10 * 60 * 1000,           // every 5 min, alert >10 min stale
  "cron/daily":           30 * 60 * 60 * 1000,      // once a day, alert >30 h stale
  "agents/run":           2 * 60 * 60 * 1000,       // every hour, alert >2 h stale
  "eval/agent_eval":      2 * 60 * 60 * 1000,
  // ERP sync / retry handlers fire every 30 minutes; alert >75 min.
  "tally/sync":           75 * 60 * 1000,
  "netsuite/sync":        75 * 60 * 1000,
  "sap/sync":             75 * 60 * 1000,
  "d365/sync":            75 * 60 * 1000,
  "acumatica/sync":       75 * 60 * 1000,
  "p21/sync":             75 * 60 * 1000,
  // The logistics monitor runs on BOTH paths: tick.js's 5-min ALWAYS group
  // (best-effort — it needs the external cron-job.org trigger, since Hobby tier
  // forbids a sub-daily vercel.json schedule) and cron/daily (the only cadence
  // Vercel actually guarantees). These two rows are the ones the daily path
  // writes, so they carry the daily bound:
  //
  //   logistics/monitor_daily  the daily registration's own row.
  //   logistics-monitor-tick   self-recorded INSIDE the handler, so it is
  //                            written by whichever path ran. On the default
  //                            10-minute bound a once-daily run would leave it
  //                            stale ~23h50m a day and hold /api/_healthz at
  //                            503 permanently.
  //
  // "logistics/monitor" — tick.js's group row — deliberately keeps the 10-minute
  // default: it is the one row that still reports whether the external 5-minute
  // trigger is alive, and relaxing it would hide that. A dead trigger also shows
  // up as a stale "cron/tick", so the signal is not lost either way.
  "logistics/monitor_daily": 30 * 60 * 60 * 1000,
  "logistics-monitor-tick":  30 * 60 * 60 * 1000,
  default:                10 * 60 * 1000,
};

// Read cron_health, classify each worker by staleness, and return
// a summary shape. Callers can use `.any_stale` for the boolean
// alert switch and `.workers` for per-row detail.
export const probeCronFreshness = async () => {
  const svc = serviceClient();
  const r = await svc.from("cron_health")
    .select("worker,last_run_at,last_status,consecutive_failures")
    .order("last_run_at", { ascending: false });
  if (r.error) return { configured: false, error: r.error.message, workers: [] };
  const rows = r.data || [];
  const now = Date.now();
  const workers = rows.map((row) => {
    const ageMs = now - new Date(row.last_run_at).getTime();
    const maxAge = CRON_EXPECTED_MAX_AGE_MS[row.worker] || CRON_EXPECTED_MAX_AGE_MS.default;
    return {
      worker: row.worker,
      last_run_at: row.last_run_at,
      last_status: row.last_status,
      consecutive_failures: row.consecutive_failures || 0,
      age_seconds: Math.round(ageMs / 1000),
      max_age_seconds: Math.round(maxAge / 1000),
      stale: ageMs > maxAge,
    };
  });
  const stale = workers.filter((w) => w.stale);
  const tick = workers.find((w) => w.worker === "cron/tick");
  const daily = workers.find((w) => w.worker === "cron/daily");
  return {
    configured: true,
    workers,
    stale_count: stale.length,
    stale_workers: stale.map((w) => w.worker),
    any_stale: stale.length > 0,
    tick_known: !!tick,
    tick_stale: !!tick?.stale,
    daily_known: !!daily,
    daily_stale: !!daily?.stale,
    generated_at: new Date(now).toISOString(),
  };
};

// Side-effecting alert emit. Right now this is console.warn so
// Vercel's log drain picks it up; once Sentry / Pagerduty is
// wired the same shape goes through them. Idempotent: callers
// invoke this on every daily run and the receiving log pipeline
// dedups on the worker name.
export const emitStaleCronAlert = (summary) => {
  if (!summary || !summary.any_stale) return null;
  const tick = summary.tick_stale ? "[CRITICAL] cron/tick is stale" : null;
  const daily = summary.daily_stale ? "[WARN] cron/daily is stale" : null;
  const others = summary.stale_workers
    .filter((w) => w !== "cron/tick" && w !== "cron/daily")
    .map((w) => "[WARN] " + w + " is stale");
  const lines = [tick, daily, ...others].filter(Boolean);
  for (const line of lines) {
    // eslint-disable-next-line no-console
    console.warn("[heartbeat-check] " + line);
  }
  return { fired: lines.length, lines };
};

export const STALE_TICK_BELL_KIND = "cron_tick_stale";
const MAX_TENANTS_BELLED = 1000;

// The admin bell for a stale 5-minute tick. The console.warn above reaches
// only the log drain, so a tenant's admins learned the worker was down when
// their background extractions, inbound email and ERP retries stopped
// moving. The tick runs that work for every tenant, so each tenant's admins
// get one bell row (through notifyAdmins, the one bell writer). Bell only:
// no email. The daily sweep calls this once a day; notifyAdmins drops a
// repeat with the same key inside five minutes, and the key carries the day.
// Never throws: a failure here must not fail the daily cron.
//
// It also rings when cron_health has no cron/tick row at all while the
// daily row is there. That is the likely state of a new deployment whose
// external 5-minute trigger was never set up: the daily path writes its
// heartbeats, so cron_health works, and the tick has simply never run.
// With no cron/daily row either, cron_health itself is not being written,
// and nothing here can tell a dead tick from a missing table.
export const bellStaleTick = async (svc, summary) => {
  if (!summary) return { tenants: 0, notified: 0 };
  const neverRan = !summary.tick_known && !!summary.daily_known;
  if (!summary.tick_stale && !neverRan) return { tenants: 0, notified: 0 };
  try {
    const tick = (summary.workers || []).find((w) => w.worker === "cron/tick") || {};
    const minutes = Math.round((Number(tick.age_seconds) || 0) / 60);
    const body = neverRan
      ? "There is no record of the 5-minute worker (cron/tick) running. "
        + "Background extraction, inbound email, ERP retries and agent runs wait until it runs."
      : "The 5-minute worker (cron/tick) last ran " + minutes + " minutes ago. "
        + "Background extraction, inbound email, ERP retries and agent runs wait until it runs again.";
    const tenants = await svc.from("tenants").select("id").limit(MAX_TENANTS_BELLED);
    if (tenants.error) return { tenants: 0, notified: 0, error: tenants.error.message };
    const day = new Date().toISOString().slice(0, 10);
    let notified = 0;
    for (const t of tenants.data || []) {
      if (!t || !t.id) continue;
      const r = await notifyAdmins(svc, t.id, {
        kind: STALE_TICK_BELL_KIND,
        title: neverRan ? "The background worker has not run" : "The background worker has stopped running",
        body,
        object_type: "cron_worker",
      }, { roles: ["admin"], dedupKey: "cron_tick_stale:" + day });
      notified += Number(r && r.notified) || 0;
    }
    return { tenants: (tenants.data || []).length, notified };
  } catch (err) {
    return { tenants: 0, notified: 0, error: (err && err.message) || String(err) };
  }
};
