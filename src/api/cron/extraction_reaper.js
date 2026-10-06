// Cron: resolve extraction runs stranded at status='running'.
//
// run.js writes the terminal status only in its FINAL update, so a function
// killed at the serverless ceiling (60s on the current plan) leaves the row
// 'running' for ever — no attempts, no error, no finished_at — and the
// workspace shows a spinner that never resolves.
//
// The run budget in run.js is the primary defence; this sweeps what it cannot
// cover (a hard kill, a crash between insert and final update, a deploy
// mid-run). The diagnostics read path calls the same helper tenant-scoped, so
// an operator opening Pipeline diag sees the truth immediately; this is the
// unattended backstop across all tenants.
//
// Cron via Bearer CRON_SECRET, or an authed admin for a manual sweep.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { reapStaleRuns } from "../_lib/docai/reap-stale-runs.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = String(req.headers?.authorization || "");
    const isCron = !!CRON_SECRET && auth === "Bearer " + CRON_SECRET;

    let tenantId = null;
    if (!isCron) {
      // Manual sweep: admin-only, and scoped to that admin's tenant.
      const ctx = await resolveContext(req);
      requirePermission(ctx, "approve");
      tenantId = ctx.tenantId;
    }

    const svc = serviceClient();
    const staleMinutes = Number(req.query?.stale_minutes) || undefined;
    const out = await reapStaleRuns(svc, { tenantId, staleMinutes });

    return json(res, 200, {
      ok: true,
      scope: tenantId ? "tenant" : "all_tenants",
      reaped: out.reaped,
      ids: out.ids,
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
