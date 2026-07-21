// GET /api/eval/dashboard?suite=
// Returns recent runs, accuracy by suite, accuracy by case, accuracy by field, plus trend arrays.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computeExtractionQuality } from "./quality.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const suite = req.query.suite;
    let runsQ = svc.from("eval_runs").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(50);
    if (suite) runsQ = runsQ.eq("suite", suite);
    const runs = await runsQ;
    if (runs.error) throw new Error(runs.error.message);
    const runIds = (runs.data || []).map((r) => r.id);
    let cases = { data: [] };
    if (runIds.length) cases = await svc.from("eval_case_results").select("*").eq("tenant_id", ctx.tenantId).in("run_id", runIds);
    const fieldStats = {};
    (cases.data || []).forEach((cr) => {
      (cr.checks || []).forEach((check) => {
        if (!check || !check.name) return;
        const key = check.name;
        fieldStats[key] = fieldStats[key] || { name: key, pass: 0, fail: 0 };
        if (check.ok) fieldStats[key].pass++;
        else fieldStats[key].fail++;
      });
    });
    const accuracyBySuite = {};
    (runs.data || []).forEach((r) => {
      accuracyBySuite[r.suite] = accuracyBySuite[r.suite] || { suite: r.suite, runs: 0, score_sum: 0, last_run: null };
      accuracyBySuite[r.suite].runs += 1;
      accuracyBySuite[r.suite].score_sum += Number(r.total_score) || 0;
      if (!accuracyBySuite[r.suite].last_run || r.created_at > accuracyBySuite[r.suite].last_run) accuracyBySuite[r.suite].last_run = r.created_at;
    });
    const suiteSummary = Object.values(accuracyBySuite).map((s) => ({ ...s, avg_score: s.runs ? s.score_sum / s.runs : 0 }));
    const trend = (runs.data || []).slice(0, 30).map((r) => ({ created_at: r.created_at, total_score: Number(r.total_score) || 0, suite: r.suite })).reverse();

    // CM P4: the operator-corrected defect rate (DPMO / sigma) over a window,
    // from live extraction_runs + extraction_corrections. Best-effort: a query
    // failure (e.g. an un-migrated deploy) degrades to available:false rather
    // than 500ing the whole dashboard.
    let quality = null;
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
      quality = await computeExtractionQuality(svc, { tenantId: ctx.tenantId, days });
    } catch (e) {
      quality = { available: false, reason: (e && e.message) || String(e) };
    }

    return json(res, 200, {
      runs: runs.data,
      caseResults: cases.data,
      suiteSummary,
      fieldStats: Object.values(fieldStats).map((f) => ({ ...f, accuracy: f.pass + f.fail === 0 ? 0 : f.pass / (f.pass + f.fail) })),
      trend,
      quality,
    });
  } catch (err) {
    sendError(res, err);
  }
}
