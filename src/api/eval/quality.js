// CM P4: extraction quality metric — the human-facing six-sigma number.
//
// Measures the OPERATOR-CORRECTED defect rate: fields that shipped (on a
// status='ok' run) yet an operator later had to fix. This is a LOWER BOUND on
// the true escape rate — a defect nobody noticed is unobservable by
// construction — so it is labelled "operator-corrected", not raw "escape rate".
//
//   defects       = COUNT(DISTINCT extraction_run_id, field_path) of
//                   extraction_corrections on shipped runs (dedup required:
//                   correction.js inserts one row per edit, no unique key).
//   opportunities = Σ over shipped runs [ H + (L × F) ], the six-sigma
//                   unit×opportunities model: each extracted LINE is a unit, a
//                   FIXED critical-to-quality (CTQ) field set is the
//                   opportunities-per-unit. A fixed CTQ set (not every nullable
//                   schema slot) keeps DPMO un-gameable by extraction verbosity.
//   escape_rate   = defects / opportunities ; dpmo = ×1e6 ; sigma from dpmo.
//
// Shared so the dashboard block AND the alerting cron compute it identically.

// Pinned CTQ field sets. Changing these changes the sigma number, so they are
// declared constants, not derived per-run.
export const CORE_HEADER_FIELDS = ["po_number", "customer.name", "po_date", "currency", "vendor_code"];
export const CORE_LINE_FIELDS = ["partNumber", "description", "quantity", "unitPrice", "uom"];
const H = CORE_HEADER_FIELDS.length; // 5
const F = CORE_LINE_FIELDS.length;   // 5

// status='ok' runs that aren't real "ships" — 0-line / non-PO / dedupe replays.
const EXCLUDED_STATUS_REASONS = new Set(["empty_lines", "non_po", "dedupe_hit", "non_ack"]);

// Peter Acklam's inverse-normal CDF approximation (JS has no NORMSINV).
const invNorm = (p) => {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
};

// Process-sigma from DPMO using the conventional +1.5σ short-term shift.
// Capped at [0, 6]. 3.4 DPMO ≈ 6σ; 6210 ≈ 4σ; 66807 ≈ 3σ.
export const sigmaFromDpmo = (dpmo) => {
  if (dpmo == null || !Number.isFinite(dpmo) || dpmo < 0) return null;
  const yieldFrac = 1 - dpmo / 1e6;
  if (yieldFrac >= 1) return 6;
  if (yieldFrac <= 0) return 0;
  const sigma = invNorm(yieldFrac) + 1.5;
  return Math.max(0, Math.min(6, Math.round(sigma * 100) / 100));
};

// Line count for a shipped run, from the per-line keys the adapters write into
// field_confidences ({ overall, "lines[0]": .., "lines[1]": .. }). Light: no
// need to pull the whole normalized_extract blob.
const lineCountOf = (run) => {
  const fc = run && run.field_confidences;
  if (fc && typeof fc === "object") {
    let n = 0;
    for (const k of Object.keys(fc)) if (/^lines\[\d+\]/.test(k)) n++;
    return n;
  }
  return 0;
};

// Compute the operator-corrected defect rate over a window. Pure DB reads,
// tenant-scoped. Returns { available, ...metrics } — never throws for a caller
// that wants to degrade gracefully (returns { available:false, reason }).
export const computeExtractionQuality = async (svc, { tenantId, days = 90, maxRuns = 5000 } = {}) => {
  const windowDays = Math.min(365, Math.max(1, Number(days) || 90));
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();

  const runsQ = await svc.from("extraction_runs")
    .select("id, field_confidences, status_reason")
    .eq("tenant_id", tenantId)
    .eq("status", "ok")
    .gte("finished_at", sinceIso)
    .limit(Math.min(20000, Math.max(1, maxRuns)));
  if (runsQ.error) return { available: false, reason: runsQ.error.message, window_days: windowDays };

  let opportunities = 0;
  let units = 0;
  const shippedIds = [];
  for (const r of (runsQ.data || [])) {
    if (EXCLUDED_STATUS_REASONS.has(r.status_reason)) continue;
    const lines = lineCountOf(r);
    if (lines <= 0) continue; // no real PO work → not a "unit produced"
    units += lines;
    opportunities += H + lines * F;
    shippedIds.push(r.id);
  }

  let defects = 0;
  const correctedRuns = new Set();
  if (shippedIds.length) {
    const idSet = new Set(shippedIds);
    const corrQ = await svc.from("extraction_corrections")
      .select("extraction_run_id, field_path")
      .eq("tenant_id", tenantId)
      .gte("applied_at", sinceIso)
      .limit(50000);
    if (!corrQ.error && Array.isArray(corrQ.data)) {
      const seen = new Set();
      for (const c of corrQ.data) {
        if (!idSet.has(c.extraction_run_id)) continue;       // only shipped runs
        const key = c.extraction_run_id + "|" + c.field_path;
        if (seen.has(key)) continue;                          // dedup re-edits
        seen.add(key);
        defects++;
        correctedRuns.add(c.extraction_run_id);
      }
    }
  }

  const escapeRate = opportunities > 0 ? defects / opportunities : 0;
  const dpmo = escapeRate * 1e6;
  return {
    available: true,
    window_days: windowDays,
    shipped_runs: shippedIds.length,
    corrected_runs: correctedRuns.size,
    units,
    opportunities_per_unit: F,
    header_opportunities_per_run: H,
    opportunities,
    defects,
    escape_rate: escapeRate,
    dpmo,
    sigma: sigmaFromDpmo(dpmo),
    method: "line-anchored-ctq",
    core_line_fields: CORE_LINE_FIELDS,
    core_header_fields: CORE_HEADER_FIELDS,
    caveat: "operator-corrected (caught) defect rate — a lower bound on true escapes",
  };
};
