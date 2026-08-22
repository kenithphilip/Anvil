// CM P4: extraction quality metric — the human-facing six-sigma number.
//
// Measures the OPERATOR-CORRECTED defect rate: fields that shipped (on a
// status='ok' run) yet an operator later had to fix. This is a LOWER BOUND on
// the true escape rate — a defect nobody noticed is unobservable by
// construction — so it is labelled "operator-corrected", not raw "escape rate".
//
// The MATH now lives in _lib/extraction-kpis.js as pure reducers, because the
// governed Metric Catalog needs the identical number (the dashboard, the
// alerting cron and the copilot must not each have their own sigma). This
// module is the I/O + envelope: fetch the window, hand it to defectRate().
//
// Re-exported here so existing importers (eval/dashboard.js,
// cron/eval_quality_alert.js, the tests) keep their import paths.
export {
  CORE_HEADER_FIELDS,
  CORE_LINE_FIELDS,
  sigmaFromDpmo,
} from "../_lib/extraction-kpis.js";

import {
  CORE_HEADER_FIELDS,
  CORE_LINE_FIELDS,
  defectRate,
} from "../_lib/extraction-kpis.js";

// Compute the operator-corrected defect rate over a window. Pure DB reads,
// tenant-scoped. Returns { available, ...metrics } — never throws for a caller
// that wants to degrade gracefully (returns { available:false, reason }).
export const computeExtractionQuality = async (svc, { tenantId, days = 90, maxRuns = 5000 } = {}) => {
  const windowDays = Math.min(365, Math.max(1, Number(days) || 90));
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();

  const runsQ = await svc.from("extraction_runs")
    .select("id, field_confidences, status, status_reason")
    .eq("tenant_id", tenantId)
    .eq("status", "ok")
    .gte("finished_at", sinceIso)
    .limit(Math.min(20000, Math.max(1, maxRuns)));
  if (runsQ.error) return { available: false, reason: runsQ.error.message, window_days: windowDays };

  // The query already filters status='ok'; isShipped() re-checks it so the
  // shared reducer works on any row set. Rows predating the `status` column
  // in this select would fail that check, so it is requested explicitly.
  const runs = (runsQ.data || []).map((r) => ({ ...r, status: r.status || "ok" }));

  let corrections = [];
  if (runs.length) {
    const corrQ = await svc.from("extraction_corrections")
      .select("extraction_run_id, field_path")
      .eq("tenant_id", tenantId)
      .gte("applied_at", sinceIso)
      .limit(50000);
    if (!corrQ.error && Array.isArray(corrQ.data)) corrections = corrQ.data;
  }

  const d = defectRate(runs, corrections);
  return {
    available: true,
    window_days: windowDays,
    shipped_runs: d.shipped_runs,
    corrected_runs: d.corrected_runs,
    units: d.units,
    opportunities_per_unit: CORE_LINE_FIELDS.length,
    header_opportunities_per_run: CORE_HEADER_FIELDS.length,
    opportunities: d.opportunities,
    defects: d.defects,
    escape_rate: d.escape_rate,
    dpmo: d.dpmo,
    sigma: d.sigma,
    method: "line-anchored-ctq",
    core_line_fields: CORE_LINE_FIELDS,
    core_header_fields: CORE_HEADER_FIELDS,
    caveat: "operator-corrected (caught) defect rate — a lower bound on true escapes",
  };
};
