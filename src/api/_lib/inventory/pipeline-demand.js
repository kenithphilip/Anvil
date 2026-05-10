// Probability-weighted pipeline demand. Reads opportunities +
// opportunity_line_items + (optionally) the (family, category) ->
// part_no map on item_master, applies the stage-default probability
// table, sums the expected qty per part per week.
//
// See docs/INVENTORY_PLANNING_DESIGN.md section 2.7 for the full
// rationale. The probability table here matches the doc; calibration
// against actual historical conversions is a Phase 2.5 follow-up.
//
// All output is keyed by ISO week (Monday-anchored YYYY-MM-DD).

// Default per-stage probabilities. Used when the operator hasn't
// overridden opportunities.probability and there's no calibrated
// per-stage win-rate yet.
export const STAGE_PROBABILITY_DEFAULTS = {
  QUALIFICATION:        0.05,
  NEEDS_ANALYSIS:       0.15,
  RFQ:                  0.30,
  INTERNAL_PROPOSAL:    0.40,
  STRATEGY_CHECK:       0.50,
  PROPOSAL_PRICE_QUOTE: 0.60,
  NEGOTIATION_REVIEW:   0.75,
  FOLLOW_UP:            0.85,
  CLOSE_WON:            1.00, // graduates into committed demand, dropped from pipeline
  CLOSE_LOST:           0.00,
  REGRETTED:            0.00,
};

// Snap a date to the ISO Monday anchor used everywhere else in
// the engine. Returns YYYY-MM-DD.
const isoWeekStart = (d) => {
  const dt = d instanceof Date ? new Date(d) : new Date(String(d));
  if (Number.isNaN(dt.getTime())) return null;
  // ISO weeks start on Monday. JS day-of-week: Sunday=0, Monday=1.
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.toISOString().slice(0, 10);
};

// Resolve a probability for one opportunity. Order of preference:
//   1. Operator-set opportunity.probability (0..1 numeric).
//   2. Calibrated per-stage win-rate (Phase 2.5; not yet supplied).
//   3. Stage default from STAGE_PROBABILITY_DEFAULTS.
//   4. 0 (unknown stage; ignore).
export const resolveOpportunityProbability = (opp, calibration = null) => {
  if (typeof opp?.probability === "number" && opp.probability >= 0 && opp.probability <= 1) {
    return opp.probability;
  }
  const stage = opp?.stage;
  if (calibration && typeof calibration[stage] === "number") return calibration[stage];
  if (typeof STAGE_PROBABILITY_DEFAULTS[stage] === "number") {
    return STAGE_PROBABILITY_DEFAULTS[stage];
  }
  return 0;
};

// Compute pipeline demand for a list of (opportunity, lines) pairs.
// Output: Map<part_no, Map<weekStart, qty>>.
//
// Inputs:
//   pairs: [{ opp: <opportunity row>, lines: [<opportunity_line_items rows>] }]
//   calibration: optional per-stage probability override
//   resolveCategoryToPartNo: function (family, category) -> part_no
//                            (used when a line has no part_no set
//                            because the operator hasn't matched
//                            the family/category to a master item).
export const computePipelineDemand = ({
  pairs, calibration = null, resolveCategoryToPartNo = null,
}) => {
  const out = new Map();
  for (const { opp, lines } of (pairs || [])) {
    const prob = resolveOpportunityProbability(opp, calibration);
    if (prob <= 0) continue;
    for (const line of (lines || [])) {
      let partNo = line.part_no;
      if (!partNo && resolveCategoryToPartNo) {
        partNo = resolveCategoryToPartNo(line.product_family, line.product_category);
      }
      if (!partNo) continue;
      const closeDate = line.expected_close_date || opp.close_date;
      const weekKey = isoWeekStart(closeDate);
      if (!weekKey) continue;
      const expectedQty = (Number(line.qty) || 0) * prob;
      if (expectedQty <= 0) continue;
      if (!out.has(partNo)) out.set(partNo, new Map());
      const bucket = out.get(partNo);
      bucket.set(weekKey, (bucket.get(weekKey) || 0) + expectedQty);
    }
  }
  return out;
};

// Convenience: roll up the pipeline-demand map into a flat array of
// (part_no, week_start, qty) triples for upsert into demand_forecasts.
export const flattenPipelineDemand = (mapByPart) => {
  const rows = [];
  for (const [partNo, weeks] of mapByPart.entries()) {
    for (const [week, qty] of weeks.entries()) {
      rows.push({ part_no: partNo, week_start: week, qty });
    }
  }
  return rows;
};

// Per-stage transition calibration: walk historical opportunities
// and compute the actual win-rate per stage. Used to learn a
// probability vector that overrides the defaults. Returns the same
// shape as STAGE_PROBABILITY_DEFAULTS.
//
// Inputs: array of historical opps with `final_stage` ('CLOSE_WON'
// | 'CLOSE_LOST' | 'REGRETTED') and `max_stage` (the deepest stage
// the opp ever reached). For each stage we compute
//   P(close_won | reached_stage_X) = won_count / reached_count.
export const calibrateStageProbabilities = (history) => {
  const reached = {};
  const won = {};
  for (const h of (history || [])) {
    const finalStage = h?.final_stage;
    const maxStage = h?.max_stage;
    if (!maxStage) continue;
    reached[maxStage] = (reached[maxStage] || 0) + 1;
    if (finalStage === "CLOSE_WON") won[maxStage] = (won[maxStage] || 0) + 1;
  }
  const out = { ...STAGE_PROBABILITY_DEFAULTS };
  for (const stage of Object.keys(reached)) {
    if (reached[stage] >= 10) { // need >= 10 samples to override default
      out[stage] = (won[stage] || 0) / reached[stage];
    }
  }
  return out;
};

export { isoWeekStart };
