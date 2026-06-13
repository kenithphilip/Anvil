// GET /api/analytics/funnel?window_days=90
//
// Reads the analytics_funnel_daily snapshots (materialised by the
// daily cron, migration 140) into a dashboard-ready shape: the latest
// per-stage snapshot (count / value / weighted value / median age) plus
// entered/exited summed over the window so the cockpit can show funnel
// health, velocity, and conversion without re-scanning opportunities.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// Canonical open-funnel stage order for display.
const STAGE_ORDER = [
  "QUALIFICATION", "NEEDS_ANALYSIS", "STRATEGY_CHECK", "RFQ",
  "INTERNAL_PROPOSAL", "PROPOSAL_PRICE_QUOTE", "NEGOTIATION_REVIEW", "FOLLOW_UP",
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url || "/", "http://x");
    const windowDays = Math.min(365, Math.max(7, Number(url.searchParams.get("window_days") || 90)));
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);

    const r = await svc.from("analytics_funnel_daily")
      .select("day, stage, entered, exited, count_in_stage, value_in_stage, weighted_value_in_stage, median_age_days, p90_age_days")
      .eq("tenant_id", ctx.tenantId)
      .gte("day", since)
      .order("day", { ascending: true });
    if (r.error) throw new Error(r.error.message);
    const rows = r.data || [];

    // Per stage: latest row that carries a snapshot (count_in_stage set),
    // plus entered/exited summed across the window.
    const byStage = new Map();
    let asOf = null;
    for (const row of rows) {
      if (row.day && (!asOf || row.day > asOf)) asOf = row.day;
      let s = byStage.get(row.stage);
      if (!s) { s = { stage: row.stage, entered: 0, exited: 0, snapshot: null, snapshot_day: null }; byStage.set(row.stage, s); }
      s.entered += Number(row.entered) || 0;
      s.exited += Number(row.exited) || 0;
      if (row.count_in_stage != null && (!s.snapshot_day || row.day >= s.snapshot_day)) {
        s.snapshot_day = row.day;
        s.snapshot = {
          count_in_stage: Number(row.count_in_stage) || 0,
          value_in_stage: Number(row.value_in_stage) || 0,
          weighted_value_in_stage: Number(row.weighted_value_in_stage) || 0,
          median_age_days: row.median_age_days != null ? Number(row.median_age_days) : null,
          p90_age_days: row.p90_age_days != null ? Number(row.p90_age_days) : null,
        };
      }
    }

    const orderOf = (st) => { const i = STAGE_ORDER.indexOf(st); return i < 0 ? 99 : i; };
    const stages = Array.from(byStage.values())
      .map((s) => ({
        stage: s.stage,
        entered: s.entered,
        exited: s.exited,
        count_in_stage: s.snapshot ? s.snapshot.count_in_stage : 0,
        value_in_stage: s.snapshot ? s.snapshot.value_in_stage : 0,
        weighted_value_in_stage: s.snapshot ? s.snapshot.weighted_value_in_stage : 0,
        median_age_days: s.snapshot ? s.snapshot.median_age_days : null,
        p90_age_days: s.snapshot ? s.snapshot.p90_age_days : null,
      }))
      .sort((a, b) => orderOf(a.stage) - orderOf(b.stage));

    const totals = stages.reduce((acc, s) => ({
      count_in_stage: acc.count_in_stage + s.count_in_stage,
      value_in_stage: acc.value_in_stage + s.value_in_stage,
      weighted_value_in_stage: acc.weighted_value_in_stage + s.weighted_value_in_stage,
    }), { count_in_stage: 0, value_in_stage: 0, weighted_value_in_stage: 0 });

    return json(res, 200, { as_of: asOf, window_days: windowDays, stages, totals });
  } catch (err) { sendError(res, err); }
}
