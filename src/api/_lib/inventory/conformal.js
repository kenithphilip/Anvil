// Conformal-prediction safety stock. Bet 3.
//
// Pure-JS implementation of three CP variants:
//
//   - splitCP(residuals, alpha)
//       Exchangeable-data CP. Sort the absolute residuals, take the
//       ceil((n+1)(1-alpha))/n quantile. Cheap, valid when the
//       sequence is i.i.d. Used as a fallback for SKUs with
//       12-25 residuals (history too short for a confident NEXCP
//       weighting).
//
//   - nexCP(residuals, alpha, rho)
//       Non-exchangeable CP per Barber, Candes, Ramdas, Tibshirani
//       2023 (https://www.stat.cmu.edu/~ryantibs/papers/nexcp.pdf).
//       Each residual gets an exponentially-decaying weight w_i =
//       rho^(n - i); we sort by absolute residual, accumulate
//       normalized weights, and return the residual at the
//       cumulative-weight threshold (1 - alpha). This is the
//       default for SKUs with >= 26 residuals. rho defaults to 0.99
//       (slow decay, suitable for weekly demand series).
//
//   - pooledColdStartCP(residualsByClass, partClass, alpha)
//       Pools residuals across an item_type cohort when the part
//       has < 12 own residuals. Returns Split CP on the pool.
//
//   - intervalForForecast({ pointForecast, qLo, qHi })
//       Adds the residual quantiles to the point forecast to build
//       the prediction band. Clamped at zero (demand is non-
//       negative).
//
//   - safetyStockFromInterval({ interval_hi, ltdMean })
//       Converts the upper-band over the lead-time window into a
//       safety-stock add-on: ss = max(0, interval_hi - ltdMean).
//
// All functions are deterministic, pure, allocation-light. No I/O.
// No dependence on the rest of the engine; tests can drive it
// directly with synthetic series.

const DEFAULT_RHO = 0.99;

// ---- internal helpers ------------------------------------------

const finiteNumber = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const sanitizeResiduals = (residuals) => {
  if (!Array.isArray(residuals)) return [];
  const out = [];
  for (const r of residuals) {
    // Null / undefined are missing data, not zero. Skip them so
    // they don't bias the quantile toward zero. Numeric zeros
    // (legitimate "I forecasted X, sold X") stay.
    if (r == null) continue;
    const v = finiteNumber(r);
    if (v != null) out.push(v);
  }
  return out;
};

// Weighted-quantile over (abs(residuals), weights). Returns the
// smallest |residual| whose cumulative normalized weight is at
// least target. target must be in (0, 1). When the cumulative
// weight tops out below target (numerical edge case), returns the
// largest |residual| in the set.
//
// Barber et al. 2023's "weighted quantile" definition (section 2),
// adapted: we use absolute residuals to build a symmetric band
// (lo = -q, hi = +q). The asymmetric case (different lo/hi
// quantiles) is a future extension.
const weightedAbsQuantile = (residuals, weights, target) => {
  const n = residuals.length;
  if (n === 0) return 0;
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 0) return Math.max(...residuals.map(Math.abs));
  // Pair absolute residual with weight, sort ascending by |r|.
  const pairs = residuals
    .map((r, i) => ({ abs: Math.abs(r), w: weights[i] / wSum }))
    .sort((a, b) => a.abs - b.abs);
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= target) return p.abs;
  }
  return pairs[pairs.length - 1].abs;
};

// ---- public methods --------------------------------------------

// Split CP. residuals: array of (actual - forecast) values.
// alpha: nominal coverage (e.g. 0.95). Returns { qLo, qHi, method,
// effective_n } where the band is symmetric (qLo = -qHi). For
// asymmetric variants, see the doc.
export const splitCP = (residuals, alpha = 0.95) => {
  const clean = sanitizeResiduals(residuals);
  const n = clean.length;
  if (n === 0) return { qLo: 0, qHi: 0, method: "split_cp", effective_n: 0 };
  // ceil((n+1)(1-alpha))/n quantile per the standard recipe; we
  // also bound at 1 so we don't index past the end.
  const target = Math.min(1, Math.ceil((n + 1) * alpha) / n);
  const weights = new Array(n).fill(1);
  const q = weightedAbsQuantile(clean, weights, target);
  return { qLo: -q, qHi: q, method: "split_cp", effective_n: n };
};

// Non-exchangeable CP (NEXCP). residuals: time-ordered array, most
// recent LAST. alpha: nominal coverage. rho: decay rate; lower rho
// = faster decay = more recent-history weight. Returns the same
// shape as splitCP plus an `effective_weight_sum` so the caller
// can sanity-check the weighting actually decayed something.
export const nexCP = (residuals, alpha = 0.95, rho = DEFAULT_RHO) => {
  const clean = sanitizeResiduals(residuals);
  const n = clean.length;
  if (n === 0) return { qLo: 0, qHi: 0, method: "nexcp", effective_n: 0 };
  // w_i = rho^(n - 1 - i). The last residual (most recent) gets
  // weight 1; the oldest gets rho^(n-1).
  const weights = new Array(n);
  for (let i = 0; i < n; i++) weights[i] = Math.pow(rho, n - 1 - i);
  const target = Math.min(1, alpha);
  const q = weightedAbsQuantile(clean, weights, target);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return {
    qLo: -q,
    qHi: q,
    method: "nexcp",
    effective_n: n,
    effective_weight_sum: weightSum,
  };
};

// Pooled cold-start CP for new SKUs. residualsByClass: a map keyed
// by item_type (or any cohort key); partClass: the new SKU's class.
// alpha: nominal coverage. We pool every residual from the same
// class and run Split CP on the union. Falls back to a wider
// pool if the named cohort has < 12 residuals; finally to a global
// pool if everything is sparse.
export const pooledColdStartCP = (residualsByClass, partClass, alpha = 0.95) => {
  const map = residualsByClass || {};
  const own = sanitizeResiduals(map[partClass] || []);
  let pool = own;
  if (pool.length < 12) {
    // Union across all cohorts. Caller can pre-filter if certain
    // classes shouldn't mix (e.g. ATD residuals don't pool with
    // CONSUMABLE).
    pool = Object.values(map).flatMap((arr) => sanitizeResiduals(arr));
  }
  const out = splitCP(pool, alpha);
  return { ...out, method: "pooled_cold_start" };
};

// Build the prediction band on the forecast scale.
// pointForecast: scalar (the period's E[D]). qLo / qHi: the
// residual quantiles from one of the CP methods above. Clamped at
// zero on the lo side because demand is non-negative.
export const intervalForForecast = ({ pointForecast, qLo, qHi }) => {
  const pf = finiteNumber(pointForecast) || 0;
  const lo = Math.max(0, pf + (finiteNumber(qLo) || 0));
  const hi = Math.max(lo, pf + (finiteNumber(qHi) || 0));
  return { interval_lo: lo, interval_hi: hi };
};

// Translate the interval into a safety-stock add-on over the
// lead-time window. The interval is already on the LTD scale when
// the caller multiplies pointForecast by leadTimeWeeks; we accept
// interval_hi and ltdMean separately so the caller controls that
// multiplication.
export const safetyStockFromInterval = ({ interval_hi, ltdMean }) => {
  const hi = finiteNumber(interval_hi) || 0;
  const mean = finiteNumber(ltdMean) || 0;
  return Math.max(0, hi - mean);
};

// Selector that wraps the three methods. Inputs:
//   - residuals       per-SKU rolling residuals, oldest -> newest
//   - alpha           nominal coverage target (0.5..1.0)
//   - method          'nexcp' | 'split_cp' (tenant pref); default 'nexcp'
//   - rho             NEXCP decay rate; default 0.99
//   - cohortResiduals optional cohort pool for pooled_cold_start
//   - cohortKey       this SKU's item_type / cohort key
//
// Returns { qLo, qHi, method, effective_n, calibration_residuals_count }.
// Routing:
//   < 12 own residuals -> pooled_cold_start (or returns zeros when
//     no cohort is supplied)
//   12-25 -> split_cp (history too short for confident weighting)
//   >= 26 -> requested method (nexcp by default)
export const selectAndComputeCP = ({
  residuals, alpha = 0.95, method = "nexcp", rho = DEFAULT_RHO,
  cohortResiduals = null, cohortKey = null,
}) => {
  const clean = sanitizeResiduals(residuals);
  const n = clean.length;
  if (n < 12) {
    if (cohortResiduals) {
      const r = pooledColdStartCP(cohortResiduals, cohortKey, alpha);
      return { ...r, calibration_residuals_count: n };
    }
    return {
      qLo: 0, qHi: 0,
      method: "pooled_cold_start",
      effective_n: n,
      calibration_residuals_count: n,
    };
  }
  if (n < 26) {
    const r = splitCP(clean, alpha);
    return { ...r, calibration_residuals_count: n };
  }
  if (method === "split_cp") {
    const r = splitCP(clean, alpha);
    return { ...r, calibration_residuals_count: n };
  }
  const r = nexCP(clean, alpha, rho);
  return { ...r, calibration_residuals_count: n };
};

// LTD-scaled interval. The cron multiplies the per-period band by
// the lead-time window so the safety-stock add-on covers the full
// horizon between an order and its receipt.
//
//   intervalHiLTD = leadTimeWeeks * interval_hi_per_period
//                   + sqrt(leadTimeWeeks) * sigma_lt_inflation
//
// We use the multiplicative approximation here (interval scales
// with leadTimeWeeks) plus an additive sqrt term for the
// lead-time variance, mirroring the Hadley-Whitin compound formula
// used by `ltdStats`.
export const scaleIntervalToLTD = ({
  interval_lo, interval_hi, leadTimeWeeks, leadTimeSigmaWeeks = 0,
}) => {
  const lo = finiteNumber(interval_lo) || 0;
  const hi = finiteNumber(interval_hi) || 0;
  const L = Math.max(0, finiteNumber(leadTimeWeeks) || 0);
  const Lsig = Math.max(0, finiteNumber(leadTimeSigmaWeeks) || 0);
  const ltdLo = Math.max(0, lo * L - Lsig * Math.sqrt(L));
  const ltdHi = Math.max(ltdLo, hi * L + Lsig * Math.sqrt(L));
  return { interval_lo_ltd: ltdLo, interval_hi_ltd: ltdHi };
};

// Empirical-coverage diagnostic. residuals + previously-stamped
// intervals over the same period. Returns the fraction of
// observations that fell inside their stamped interval. Used by
// the conformal_diagnostics endpoint to chart actual vs. nominal
// coverage.
export const empiricalCoverage = (samples) => {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { coverage: null, n: 0 };
  }
  let inside = 0;
  let n = 0;
  for (const s of samples) {
    const lo = finiteNumber(s?.interval_lo);
    const hi = finiteNumber(s?.interval_hi);
    const act = finiteNumber(s?.actual);
    if (lo == null || hi == null || act == null) continue;
    n += 1;
    if (act >= lo && act <= hi) inside += 1;
  }
  return { coverage: n ? inside / n : null, n };
};

// Test-only exports so unit tests can lock individual primitives.
export const __test = {
  weightedAbsQuantile, sanitizeResiduals, DEFAULT_RHO,
};
