// Extraction quality KPIs — the PURE reducers over extraction_runs /
// extraction_corrections rows. No I/O, no clock, no tenant lookup.
//
// Why this file exists: extraction_runs already carries a rich per-run quality
// record (field_confidences, status/status_reason, parse_method, anomalies,
// prompt_version) and until now exactly ONE aggregation of it reached a human
// (eval/quality.js, on a dashboard). The rest was computed and discarded —
// docai/cost_status.js builds a parse-method rollup on every call that no
// screen consumes. Meanwhile the governed Metric Catalog, the only surface the
// copilot is allowed to quote a number from, had 22 metrics and none about
// extraction: you could ask Anvil for overdue AR but not whether the machine
// that reads your purchase orders was getting better or worse.
//
// So the math lives here, once, and both the catalog and eval/quality.js call
// it — the same pattern as _lib/ops-kpis.js backing the finance metrics. The
// dashboard, the alerting cron and the copilot must quote the SAME number.

// ── the six-sigma model (moved verbatim from eval/quality.js) ─────────
//
// Pinned CTQ field sets. Changing these changes the sigma number, so they are
// declared constants, not derived per-run. A FIXED critical-to-quality set
// (not every nullable schema slot) keeps DPMO un-gameable by extraction
// verbosity: an adapter cannot improve its score by emitting more fields.
export const CORE_HEADER_FIELDS = ["po_number", "customer.name", "po_date", "currency", "vendor_code"];
export const CORE_LINE_FIELDS = ["partNumber", "description", "quantity", "unitPrice", "uom"];
const H = CORE_HEADER_FIELDS.length; // 5
const F = CORE_LINE_FIELDS.length;   // 5

// status='ok' runs that aren't real "ships" — 0-line / non-PO / dedupe replays.
export const EXCLUDED_STATUS_REASONS = new Set(["empty_lines", "non_po", "dedupe_hit", "non_ack"]);

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

// Line count for a run, from the per-line keys the adapters write into
// field_confidences ({ overall, "lines[0]": .., "lines[1]": .. }). Light: no
// need to pull the whole normalized_extract blob.
export const lineCountOf = (run) => {
  const fc = run && run.field_confidences;
  if (fc && typeof fc === "object") {
    let n = 0;
    for (const k of Object.keys(fc)) if (/^lines\[\d+\]/.test(k)) n++;
    return n;
  }
  return 0;
};

// A run "shipped" when it produced real extracted work a human then relied on.
// Anything else is not a unit of production and must not dilute the denominator.
export const isShipped = (r) =>
  !!r && r.status === "ok" && !EXCLUDED_STATUS_REASONS.has(r.status_reason) && lineCountOf(r) > 0;

// A run is FINISHED when the pipeline reached a verdict. 'running' rows are
// in flight, not outcomes — counting them would make every rate drift with
// however many extractions happen to be mid-flight at read time.
export const isFinished = (r) => !!r && r.status != null && r.status !== "running";

// ── prompt attribution ───────────────────────────────────────────────
//
// extraction_runs.prompt_version is jsonb (migration 124) holding
// { name, version, source, ... }. Accept a bare string too: that is the shape
// the first version of the writer emitted, and those rows are in production.
// Rows written before anything wrote the column at all group as 'unrecorded'
// — named, not dropped, so the share of unattributable history is visible
// rather than silently improving every comparison.
export const UNRECORDED_PROMPT = "unrecorded";
export const promptVersionKey = (run) => {
  const pv = run && run.prompt_version;
  if (!pv) return UNRECORDED_PROMPT;
  if (typeof pv === "string") return pv;
  if (typeof pv === "object") {
    if (pv.label) return String(pv.label);
    if (pv.name && pv.version) return `${pv.name}@${pv.version}`;
    if (pv.version) return String(pv.version);
  }
  return UNRECORDED_PROMPT;
};

export const kindKey = (run) => String((run && run.extraction_kind) || "unknown");

// Group rows by a key function, preserving first-seen order.
export const groupBy = (rows, keyFn) => {
  const out = new Map();
  for (const r of rows || []) {
    const k = keyFn(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── 1. operator-corrected defect rate (DPMO / sigma) ─────────────────
//
// Measures fields that shipped on an ok run yet an operator later had to fix.
// A LOWER BOUND on the true escape rate — a defect nobody noticed is
// unobservable by construction — so it is labelled "operator-corrected".
//
//   defects       = COUNT(DISTINCT run_id, field_path) of corrections on
//                   shipped runs (dedup required: correction.js inserts one
//                   row per edit, with no unique key).
//   opportunities = Σ over shipped runs [ H + (L × F) ]
export const defectRate = (runs, corrections) => {
  let units = 0;
  let opportunities = 0;
  const shippedIds = [];
  for (const r of runs || []) {
    if (!isShipped(r)) continue;
    const lines = lineCountOf(r);
    units += lines;
    opportunities += H + lines * F;
    shippedIds.push(r.id);
  }

  const idSet = new Set(shippedIds);
  const seen = new Set();
  const correctedRuns = new Set();
  let defects = 0;
  for (const c of corrections || []) {
    if (!idSet.has(c.extraction_run_id)) continue;   // only shipped runs
    const key = c.extraction_run_id + "|" + c.field_path;
    if (seen.has(key)) continue;                      // dedup re-edits
    seen.add(key);
    defects++;
    correctedRuns.add(c.extraction_run_id);
  }

  const escapeRate = opportunities > 0 ? defects / opportunities : 0;
  const dpmo = escapeRate * 1e6;
  return {
    shipped_runs: shippedIds.length,
    corrected_runs: correctedRuns.size,
    units,
    opportunities,
    defects,
    escape_rate: escapeRate,
    dpmo,
    sigma: sigmaFromDpmo(dpmo),
    run_ids: shippedIds,
  };
};

// ── 2. run outcomes: what the pipeline decided ───────────────────────
export const runOutcomes = (runs) => {
  const finished = (runs || []).filter(isFinished);
  const n = finished.length;
  const count = (pred) => finished.filter(pred).length;
  const failed = count((r) => r.status === "failed");
  const review = count((r) => r.status === "low_confidence");
  const reasons = {};
  for (const r of finished) {
    if (r.status === "ok") continue;                  // only failure taxonomy
    const k = r.status_reason || r.status || "unknown";
    reasons[k] = (reasons[k] || 0) + 1;
  }
  return {
    finished: n,
    running: (runs || []).length - n,
    ok: count((r) => r.status === "ok"),
    failed,
    low_confidence: review,
    failure_rate: pct(failed, n),
    review_rate: pct(review, n),
    reasons,
  };
};

// ── 3. parse health — the rollup cost_status.js computes and throws away ──
//
// parse_method records HOW the model's output became JSON: natively, via the
// legacy tool_use path, or only after a repair pass. A rising repair rate is
// the early warning that precedes a rising failure rate, which is why it is
// reported next to it rather than folded into it.
export const REPAIR_METHODS = new Set(["sap_repaired", "sap_zod_retry"]);
export const parseHealth = (runs) => {
  const rows = (runs || []).filter((r) => r && r.parse_method != null);
  const n = rows.length;
  const byMethod = {};
  let failed = 0;
  let repaired = 0;
  let retries = 0;
  for (const r of rows) {
    const k = r.parse_method || "unknown";
    byMethod[k] = (byMethod[k] || 0) + 1;
    if (k === "failed") failed++;
    if (REPAIR_METHODS.has(k)) repaired++;
    retries += Number(r.parse_retries) || 0;
  }
  return {
    parsed_runs: n,
    by_method: byMethod,
    failed,
    repaired,
    parse_failure_rate: pct(failed, n),
    repair_rate: pct(repaired, n),
    retries_per_run: n > 0 ? round2(retries / n) : 0,
  };
};

// ── 4. confidence distribution ───────────────────────────────────────
export const median = (xs) => {
  const s = (xs || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ── 5. prompt-version comparison — the point of recording the version ──
//
// Splits shipped runs by the prompt that produced them and scores each the
// same way. `minRuns` guards against crowning a winner on three documents:
// versions below it are still reported, flagged comparable:false, and are
// excluded from the best/worst pick.
export const promptVersionSlices = (runs, corrections, { minRuns = 20 } = {}) => {
  const groups = groupBy((runs || []).filter(isShipped), promptVersionKey);
  const slices = [];
  for (const [version, rows] of groups) {
    const d = defectRate(rows, corrections);
    slices.push({
      prompt_version: version,
      shipped_runs: d.shipped_runs,
      units: d.units,
      defects: d.defects,
      dpmo: Math.round(d.dpmo),
      sigma: d.sigma,
      comparable: version !== UNRECORDED_PROMPT && d.shipped_runs >= minRuns,
    });
  }
  slices.sort((a, b) => a.dpmo - b.dpmo || b.shipped_runs - a.shipped_runs);
  const comparable = slices.filter((s) => s.comparable);
  const best = comparable[0] || null;
  const worst = comparable.length > 1 ? comparable[comparable.length - 1] : null;
  // Relative improvement of the best version over the worst, in percent.
  // Reported relative, not in raw DPMO points, because the absolute gap
  // between two good versions is a number nobody can act on.
  const lift = best && worst && worst.dpmo > 0
    ? round2(((worst.dpmo - best.dpmo) / worst.dpmo) * 100)
    : (best && worst ? 0 : null);
  return {
    versions: slices,
    comparable_versions: comparable.length,
    min_runs: minRuns,
    best: best ? best.prompt_version : null,
    worst: worst ? worst.prompt_version : null,
    lift_pct: lift,
    unrecorded_runs: (groups.get(UNRECORDED_PROMPT) || []).length,
  };
};

// ── evidence: the rows a metric aggregated ───────────────────────────
//
// Guard from docs/EXTRACTION_QUALITY.md §8: a quality number nobody can drill
// into is a number nobody acts on. Every extraction metric carries the ids it
// counted, so "3.9 sigma" can be opened, not just believed.
export const EVIDENCE_SAMPLE = 25;
export const evidenceOf = (runIds, note) => {
  const ids = Array.isArray(runIds) ? runIds : [];
  return {
    table: "extraction_runs",
    total_runs: ids.length,
    run_ids: ids.slice(0, EVIDENCE_SAMPLE),
    truncated: ids.length > EVIDENCE_SAMPLE,
    ...(note ? { note } : {}),
  };
};

