// Demand forecasting: Croston / SBA / TSB / naive baseline.
//
// Pure-JS implementations of the intermittent-demand family
// (docs/INVENTORY_PLANNING_DESIGN.md section 3.4) plus simple
// moving-average / exponential-smoothing baselines for Smooth and
// Erratic items. The full ML model menu (NHITS / TFT / LightGBM)
// defers to a Python micro-service in a Phase 2.5 follow-up; this
// file ships the classical track so the engine has a working
// forecaster on day one.
//
// All forecasters return:
//   { mean: number,  // point forecast for the next bucket
//     model: string, // 'croston' | 'sba' | 'tsb' | 'sma' | 'ses'
//     params: {...}  // fitted parameters for diagnostic logging
//   }
//
// Inputs are weekly-bucketed history arrays (zeros included).

const SMOOTH_DEFAULT = 0.1; // alpha for level smoothing across all variants

// -------------------------------------------------------------------
// Croston (1972). Smooth demand size and inter-arrival interval
// separately, forecast = smoothed_size / smoothed_interval. Biased
// upward for intermittent series; SBA fixes this.
export const croston = (history, alpha = SMOOTH_DEFAULT) => {
  const series = (history || []).map((v) => Number(v) || 0);
  let lastSize = null;
  let lastInterval = null;
  let interval = 0;
  for (const v of series) {
    interval += 1;
    if (v > 0) {
      if (lastSize == null) { lastSize = v; lastInterval = interval; }
      else {
        lastSize = alpha * v + (1 - alpha) * lastSize;
        lastInterval = alpha * interval + (1 - alpha) * lastInterval;
      }
      interval = 0;
    }
  }
  if (lastSize == null || lastInterval == null || lastInterval <= 0) {
    return { mean: 0, model: "croston", params: { alpha, lastSize: 0, lastInterval: 0 } };
  }
  return {
    mean: lastSize / lastInterval,
    model: "croston",
    params: { alpha, lastSize, lastInterval },
  };
};

// -------------------------------------------------------------------
// Syntetos-Boylan Approximation: Croston with a `* (1 - alpha/2)`
// debiasing factor. Default forecaster for intermittent series in
// the literature.
export const sba = (history, alpha = SMOOTH_DEFAULT) => {
  const c = croston(history, alpha);
  return {
    mean: c.mean * (1 - alpha / 2),
    model: "sba",
    params: { ...c.params, debias_factor: 1 - alpha / 2 },
  };
};

// -------------------------------------------------------------------
// Teunter-Syntetos-Babai: smooth the demand *probability* every
// period instead of the inter-arrival interval. Handles obsolescence
// because probability decays toward 0 once demand stops, while
// Croston's `1 / interval` does not.
export const tsb = (history, alphaSize = SMOOTH_DEFAULT, alphaProb = SMOOTH_DEFAULT) => {
  const series = (history || []).map((v) => Number(v) || 0);
  let prob = 0;     // smoothed probability of demand
  let size = 0;     // smoothed demand size given a non-zero event
  let initialised = false;
  for (const v of series) {
    if (v > 0) {
      if (!initialised) { size = v; prob = 1; initialised = true; }
      else {
        size = alphaSize * v + (1 - alphaSize) * size;
        prob = alphaProb * 1 + (1 - alphaProb) * prob;
      }
    } else {
      prob = (1 - alphaProb) * prob;
    }
  }
  return {
    mean: prob * size,
    model: "tsb",
    params: { alphaSize, alphaProb, size, prob },
  };
};

// -------------------------------------------------------------------
// Simple moving average. Cheap baseline for Smooth items.
export const sma = (history, window = 4) => {
  const series = (history || []).map((v) => Number(v) || 0);
  const tail = series.slice(-window);
  if (!tail.length) return { mean: 0, model: "sma", params: { window } };
  return {
    mean: tail.reduce((s, v) => s + v, 0) / tail.length,
    model: "sma",
    params: { window, tail_size: tail.length },
  };
};

// -------------------------------------------------------------------
// Single exponential smoothing. Reasonable default for Erratic items
// when we don't want the bias of moving average.
export const ses = (history, alpha = 0.2) => {
  const series = (history || []).map((v) => Number(v) || 0);
  if (!series.length) return { mean: 0, model: "ses", params: { alpha } };
  let level = series[0];
  for (let i = 1; i < series.length; i++) {
    level = alpha * series[i] + (1 - alpha) * level;
  }
  return { mean: level, model: "ses", params: { alpha, level } };
};

// -------------------------------------------------------------------
// Variance estimator for safety-stock math. Uses the residuals of
// the chosen forecaster against the actuals so the sigma reflects
// model error, not raw demand volatility (the latter is the
// classical-but-naive approach).
export const residualSigma = (history, forecaster) => {
  const series = (history || []).map((v) => Number(v) || 0);
  if (series.length < 4) return 0;
  // Walk-forward one-step-ahead residuals.
  const residuals = [];
  for (let i = 4; i < series.length; i++) {
    const window = series.slice(0, i);
    const f = forecaster(window).mean;
    residuals.push(series[i] - f);
  }
  if (residuals.length < 2) return 0;
  const mean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
  const variance = residuals.reduce((s, v) => s + (v - mean) ** 2, 0) / residuals.length;
  return Math.sqrt(variance);
};

// -------------------------------------------------------------------
// Selector: returns the forecaster appropriate for the given
// demand-class label produced by classify.js. Caller is expected to
// have classified first.
export const pickForecaster = (demandClass) => {
  switch (demandClass) {
    case "intermittent": return sba;
    case "lumpy":        return tsb;
    case "erratic":      return ses;
    case "smooth":       return (h) => sma(h, 4);
    case "new":
    default:             return (h) => sma(h, 4);
  }
};

// -------------------------------------------------------------------
// WAPE per horizon: weighted absolute percentage error against
// recent actuals. Used to populate demand_forecasts.wape_4w/8w/12w.
// horizon parameter is in weeks; we look back that many points and
// score the forecaster's residuals as a percentage of total demand.
export const wape = (history, forecaster, horizon = 4) => {
  const series = (history || []).map((v) => Number(v) || 0);
  if (series.length < horizon + 4) return null;
  let absErr = 0;
  let actualSum = 0;
  for (let i = series.length - horizon; i < series.length; i++) {
    const window = series.slice(0, i);
    const f = forecaster(window).mean;
    const a = series[i];
    absErr += Math.abs(a - f);
    actualSum += a;
  }
  if (actualSum === 0) return null;
  return absErr / actualSum;
};
