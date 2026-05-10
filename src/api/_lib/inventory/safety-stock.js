// Safety-stock formulas. Three variants per
// docs/INVENTORY_PLANNING_DESIGN.md section 2.3, plus a selector
// that picks the right one based on demand class.
//
// All exports return safety-stock as a numeric quantity in the
// item's UoM. Callers are expected to round / snap to MOQ via eoq.js
// before persisting.

// Standard normal inverse CDF approximation. Pure JS, accurate to
// about 6 decimals across the range we care about (0.5 -> 0.999).
// Algorithm: Beasley-Springer-Moro, abridged.
const z = (p) => {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Beasley-Springer rational approximation, valid for 0.5 < p <= 1
  // (mirror for p < 0.5).
  const A = [-3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
  const B = [-5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
  const D = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]*q+C[1])*q+C[2])*q+C[3])*q+C[4])*q+C[5]) /
           ((((D[0]*q+D[1])*q+D[2])*q+D[3])*q+1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((A[0]*r+A[1])*r+A[2])*r+A[3])*r+A[4])*r+A[5])*q /
           (((((B[0]*r+B[1])*r+B[2])*r+B[3])*r+B[4])*r+1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((C[0]*q+C[1])*q+C[2])*q+C[3])*q+C[4])*q+C[5]) /
          ((((D[0]*q+D[1])*q+D[2])*q+D[3])*q+1);
};

// Lead-time-demand stats per the Hadley-Whitin compound formula
// (docs section 2.2):
//   E[LTD]   = L * E[D_per_period]
//   Var[LTD] = L * Var[D] + (E[D])^2 * Var[L]
// Inputs in *consistent* time units. We standardise to weekly
// throughout the engine, so leadTimeMean/Sigma should already be in
// weeks (caller converts from days).
export const ltdStats = ({ demandMean, demandSigma, leadTimeMean, leadTimeSigma }) => {
  const muLTD = leadTimeMean * demandMean;
  const varLTD = leadTimeMean * (demandSigma * demandSigma)
               + (demandMean * demandMean) * (leadTimeSigma * leadTimeSigma);
  return { ltdMean: muLTD, ltdSigma: Math.sqrt(Math.max(0, varLTD)) };
};

// Variant A: standard z-score safety stock for normally-distributed
// LTD.
export const ssNormal = ({ alpha, ltdSigma }) => {
  const zVal = z(alpha);
  if (!Number.isFinite(zVal) || ltdSigma <= 0) return 0;
  return Math.max(0, zVal * ltdSigma);
};

// Variant B: gamma-quantile safety stock for skewed/intermittent
// LTD. Uses Wilson-Hilferty's normal approximation to the gamma
// quantile, which is very accurate for shape >= 1 and tolerable
// down to shape ~0.5. shape = (E[LTD]^2 / Var[LTD]); scale =
// (Var[LTD] / E[LTD]).
export const ssGamma = ({ alpha, ltdMean, ltdSigma }) => {
  if (ltdMean <= 0 || ltdSigma <= 0) return 0;
  const variance = ltdSigma * ltdSigma;
  const shape = (ltdMean * ltdMean) / variance;
  const scale = variance / ltdMean;
  const zVal = z(alpha);
  if (!Number.isFinite(zVal)) return 0;
  // Wilson-Hilferty: gamma_inv_cdf(p; k, theta) ≈
  //   k * theta * (1 - 1/(9k) + z(p) / sqrt(9k))^3
  const inner = 1 - 1 / (9 * shape) + zVal / Math.sqrt(9 * shape);
  const quantile = shape * scale * Math.pow(Math.max(0, inner), 3);
  return Math.max(0, quantile - ltdMean);
};

// Variant C: project-equivalent floor (the spec rule). Either the
// mean of the last 4 weeks of demand, or 1 project's worth of the
// item, whichever is larger. The caller passes both candidates;
// this just picks the max.
export const ssProjectFloor = ({ avg4w, projectEquivalentQty }) => {
  return Math.max(Number(avg4w) || 0, Number(projectEquivalentQty) || 0);
};

// Selector: combine the statistical estimate with the project floor,
// always taking the max, and route to the right statistical formula
// based on demand class.
export const safetyStock = ({
  alpha, demandMean, demandSigma, leadTimeMean, leadTimeSigma,
  demandClass, avg4w = 0, projectEquivalentQty = 0,
}) => {
  const lt = ltdStats({ demandMean, demandSigma, leadTimeMean, leadTimeSigma });
  const useGamma = demandClass === "intermittent" || demandClass === "lumpy";
  const statSS = useGamma
    ? ssGamma({ alpha, ltdMean: lt.ltdMean, ltdSigma: lt.ltdSigma })
    : ssNormal({ alpha, ltdSigma: lt.ltdSigma });
  const floor = ssProjectFloor({ avg4w, projectEquivalentQty });
  return {
    ss: Math.max(statSS, floor),
    breakdown: {
      formula: useGamma ? "gamma_quantile" : "normal_z",
      stat_ss: statSS,
      project_floor: floor,
      ltd_mean: lt.ltdMean,
      ltd_sigma: lt.ltdSigma,
      z: z(alpha),
    },
  };
};

// Reorder point = E[LTD] + safety stock.
export const reorderPoint = ({ ltdMean, ss }) => Math.max(0, ltdMean + ss);

export { z as standardNormalInverse };
