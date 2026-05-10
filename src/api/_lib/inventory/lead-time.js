// Lead-time estimation per supplier per item.
//
// Strategy: read the last N >= 12 acknowledged-ETA-vs-actual-receipt
// deltas from source_pos + source_po_lines + source_po_events, fit
// a gamma distribution via method-of-moments, and return:
//   { lead_time_days, lead_time_stddev_days, source, sample_size }
//
// `source`:
//   - 'data_driven' when N >= 12 (the engine trusts the empirical fit)
//   - 'priored'     when 4 <= N < 12 (we widen toward a conservative
//                   prior to avoid over-confident planning)
//   - 'item_master_default' when N < 4 (use the item's
//                   default_lead_days; sigma is heuristically a
//                   fraction of the mean)
//
// Reference: docs/INVENTORY_PLANNING_DESIGN.md section 2.5.

const PRIOR_RELATIVE_SIGMA = 0.18; // 18% CV for the cold-start prior

// Fit gamma parameters via method-of-moments: shape = mean^2/var,
// scale = var/mean. Useful for the LTD compound in safety-stock.js.
export const gammaParams = (meanVal, sigmaVal) => {
  if (meanVal <= 0 || sigmaVal <= 0) return { shape: 0, scale: 0 };
  const variance = sigmaVal * sigmaVal;
  return {
    shape: (meanVal * meanVal) / variance,
    scale: variance / meanVal,
  };
};

// Compute mean + sample stddev from an array of numeric receipt deltas
// (in days). Skips any non-finite or negative values (a negative delta
// would mean the receipt arrived before the ETA, which we treat as a
// 0-delay sample for safety-stock math; some suppliers do over-deliver).
const stats = (deltas) => {
  const xs = (deltas || []).map((d) => Math.max(0, Number(d) || 0));
  if (!xs.length) return { mean: 0, sigma: 0, n: 0 };
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  if (xs.length < 2) return { mean, sigma: 0, n: xs.length };
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sigma: Math.sqrt(variance), n: xs.length };
};

export const estimateLeadTime = ({
  receiptDeltas,                      // array of (received_at - acknowledged_eta) in days, observed
  itemDefaultDays,                    // item_master.default_lead_days
  supplierPrior,                      // { mean_days, sigma_days } if the supplier has prior data
}) => {
  const fit = stats(receiptDeltas);
  if (fit.n >= 12 && fit.mean > 0) {
    return {
      lead_time_days: fit.mean,
      lead_time_stddev_days: fit.sigma,
      source: "data_driven",
      sample_size: fit.n,
    };
  }
  if (fit.n >= 4 && fit.mean > 0) {
    // Blend the empirical fit with a conservative prior.
    const priorMean = supplierPrior?.mean_days || itemDefaultDays || fit.mean;
    const priorSigma = supplierPrior?.sigma_days || (priorMean * PRIOR_RELATIVE_SIGMA);
    return {
      lead_time_days: 0.5 * fit.mean + 0.5 * priorMean,
      lead_time_stddev_days: Math.max(fit.sigma, priorSigma),
      source: "priored",
      sample_size: fit.n,
    };
  }
  // Cold start: fall back to the item's default_lead_days with a
  // heuristic sigma. The engine will widen the safety stock until
  // real samples arrive.
  const fallbackMean = supplierPrior?.mean_days || itemDefaultDays || 0;
  return {
    lead_time_days: fallbackMean,
    lead_time_stddev_days: fallbackMean * PRIOR_RELATIVE_SIGMA,
    source: "item_master_default",
    sample_size: fit.n,
  };
};
