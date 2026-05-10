// Demand-shape classifier: walks a weekly-bucketed history and
// labels it Smooth / Erratic / Intermittent / Lumpy / New, using
// the Syntetos-Boylan-Croston quadrant.
//
// Inputs
//   history: Array of weekly bucketed demand qty (numbers, weeks
//            in chronological order).
//
// Outputs
//   { adi, cv2, class, sample_size }
//   - adi  : Average Demand Interval (mean periods between non-zero
//            demand events). >1.32 means demand is intermittent.
//   - cv2  : Squared coefficient of variation of *non-zero* demand
//            sizes. >0.49 means the demand sizes themselves are
//            erratic.
//   - class: smooth / erratic / intermittent / lumpy / new
//
// Reference
//   Syntetos, Boylan, Croston (2005). Reviewed in
//   docs/INVENTORY_PLANNING_DESIGN.md section 3.2.

export const classifyDemand = (history) => {
  const series = Array.isArray(history) ? history.map((v) => Number(v) || 0) : [];
  // <26 weeks of history is too short to classify confidently.
  // Fall back to "new" so the engine routes to the cold-start track.
  if (series.length < 26) {
    return { adi: null, cv2: null, class: "new", sample_size: series.length };
  }
  const nonZero = series.filter((v) => v > 0);
  if (nonZero.length < 2) {
    // Only one or zero non-zero events: by definition lumpy.
    return { adi: series.length, cv2: 0, class: "lumpy", sample_size: series.length };
  }
  // ADI: total periods / number of non-zero events.
  const adi = series.length / nonZero.length;
  // CV^2 of non-zero sizes.
  const mean = nonZero.reduce((s, v) => s + v, 0) / nonZero.length;
  const variance = nonZero.reduce((s, v) => s + (v - mean) ** 2, 0) / nonZero.length;
  const cv2 = mean === 0 ? 0 : variance / (mean * mean);
  // Classify per the SBC quadrant (the cut-offs are the standard
  // ones from the literature; tunable later from tenant_settings if
  // we ever need to).
  let cls;
  if (adi <= 1.32 && cv2 <= 0.49) cls = "smooth";
  else if (adi <= 1.32 && cv2 > 0.49) cls = "erratic";
  else if (adi > 1.32 && cv2 <= 0.49) cls = "intermittent";
  else cls = "lumpy";
  return { adi, cv2, class: cls, sample_size: series.length };
};
