// GET /api/_healthz
//
// Phase 1 F9. Minimal, fast, unauthenticated probe for external
// uptime monitors (UptimeRobot, Better Stack, etc.). Returns:
//
//   200 { ok: true, ts, commit, db_ok, integrations_summary, cron }
//   503 { ok: false, ... } when db is unreachable or any cron is stale
//
// Goals:
//   - <200ms p99 (caches for 5s under hot load).
//   - No secret values, only counts + booleans.
//   - No tenant context (RLS not bypassed; service client used
//     only for the tenants-table probe and cron_health summary).
//   - No auth required so external monitors can poll without
//     vending them a token.
//
// /api/health (the operator-facing probe) is a superset that the
// shell footer renders. /api/_healthz is the small probe an
// external monitor polls every 30 seconds.

import { applyCors, handlePreflight, json } from "./_lib/cors.js";
import { serviceClient } from "./_lib/supabase.js";
import { probeCronFreshness } from "./_lib/heartbeat-check.js";

let cached = null;
const CACHE_MS = 5_000;

const probeDb = async () => {
  try {
    const svc = serviceClient();
    const { error } = await svc
      .from("tenants")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch (_) {
    return false;
  }
};

const integrationsSummary = () => {
  // Coarse boolean summary, no env-key names returned. Operators
  // who want detail hit /api/health which lists every integration.
  const required = ["ANTHROPIC_API_KEY"]; // hard requirement; the rest are optional
  const optionalChecks = {
    docai: ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "REDUCTO_API_KEY", "AZURE_DI_KEY"],
    tally: ["TALLY_BRIDGE_URL"],
    comms: ["SENDGRID_API_KEY", "RESEND_API_KEY", "COMMS_PROVIDER_URL"],
    cron: ["CRON_SECRET"],
  };
  const required_ok = required.every((k) => !!process.env[k]);
  const optional_ok = Object.fromEntries(
    Object.entries(optionalChecks).map(([k, keys]) => [k, keys.some((env) => !!process.env[env])]),
  );
  return { required_ok, ...optional_ok };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }

  const now = Date.now();
  if (cached && (now - cached.at) < CACHE_MS) {
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=5");
    return json(res, cached.status, cached.payload);
  }

  const [dbOk, cron] = await Promise.all([probeDb(), probeCronFreshness()]);
  const integrations = integrationsSummary();
  const ok = dbOk && !cron.any_stale && integrations.required_ok;
  const status = ok ? 200 : 503;
  const payload = {
    ok,
    ts: new Date(now).toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    region: process.env.VERCEL_REGION || "local",
    db_ok: dbOk,
    integrations_summary: integrations,
    cron: {
      configured: cron.configured,
      tick_stale: cron.tick_stale || false,
      daily_stale: cron.daily_stale || false,
      stale_count: cron.stale_count || 0,
      stale_workers: cron.stale_workers || [],
    },
  };
  cached = { at: now, status, payload };
  res.setHeader("Cache-Control", "public, max-age=5, s-maxage=5");
  return json(res, status, payload);
}
