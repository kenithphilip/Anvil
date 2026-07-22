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

// Committed demand from future sales-order schedule lines. Same output shape
// as computePipelineDemand (Map<part_no, Map<weekStart, qty>>) so it can be
// BOM-exploded by the SAME explodePipelineThroughBom — a confirmed SO for a
// finished good then cascades into its raw-material / component demand, exactly
// like the probability-weighted pipeline. No probability: a scheduled qty is
// firm demand. Rows without a part_no or a valid date are dropped.
//
// Inputs:
//   scheduleRows: [{ part_no, scheduled_qty, scheduled_date }] (future rows only;
//                 the caller filters scheduled_date >= today)
export const computeCommittedDemand = (scheduleRows) => {
  const out = new Map();
  for (const row of (scheduleRows || [])) {
    const partNo = row && row.part_no;
    if (!partNo) continue;
    const weekKey = isoWeekStart(row.scheduled_date);
    if (!weekKey) continue;
    const qty = Number(row.scheduled_qty) || 0;
    if (qty <= 0) continue;
    if (!out.has(partNo)) out.set(partNo, new Map());
    const bucket = out.get(partNo);
    bucket.set(weekKey, (bucket.get(weekKey) || 0) + qty);
  }
  return out;
};

// P2 (BOM-explode demand): cascade finished-good pipeline demand down
// the bill of materials into the raw materials / sub-components it
// consumes. The probability weighting already happened upstream (each
// finished part's qty is expected = qty * win-prob), so multiplying by
// the per-unit BOM quantity gives expected raw-material demand.
//
// Mutates `pipeline` in place — for every part with demand we walk its
// BOM descendants (depth-capped, cycle-guarded) and ADD
// expected_qty * cumulative_multiplier into each descendant's per-week
// bucket. A descendant that is itself a finished good keeps its own
// direct demand AND accrues component demand; both are correct.
//
// Inputs:
//   pipeline: Map<part_no, Map<weekStart, qty>>  (from computePipelineDemand)
//   bomRows:  [{ parent_part_no, child_part_no, qty }]  (one tenant's BOM)
//   opts.buyParts: optional Set<part_no> of BOUGHT-OUT parts. A buy part is a
//     TERMINAL of the explosion — it still receives demand from its parent
//     (you buy that many of the part), but it is NOT cascaded into its own
//     children/raw material (you purchase it whole). This is the defensive
//     guard that stops raw-material demand from being fabricated for parts we
//     don't machine, independent of whether a stray recipe exists.
// Returns { exploded } — count of (root → descendant) edges applied.
//
// Inert when bomRows is empty: existing tenants without a BOM are
// unaffected.
export const explodePipelineThroughBom = (pipeline, bomRows, maxDepth = 8, opts = {}) => {
  const rows = Array.isArray(bomRows) ? bomRows : [];
  if (!rows.length || !pipeline || pipeline.size === 0) return { exploded: 0 };
  const buyParts = opts && opts.buyParts instanceof Set ? opts.buyParts : null;

  const children = new Map();
  for (const r of rows) {
    if (!r || !r.parent_part_no || !r.child_part_no) continue;
    const a = children.get(r.parent_part_no) || [];
    a.push({ child: r.child_part_no, qty: Number(r.qty) || 0 });
    children.set(r.parent_part_no, a);
  }
  if (children.size === 0) return { exploded: 0 };

  // Snapshot original per-part demand so each root's contribution is
  // independent of mutation order (a root whose child is also a root
  // must not pick up the child's freshly-added component demand).
  const original = new Map();
  for (const [part, weeks] of pipeline) original.set(part, new Map(weeks));

  let exploded = 0;
  for (const [root, rootWeeks] of original) {
    const stack = [{ part: root, mult: 1, depth: 0, seen: new Set([root]) }];
    while (stack.length) {
      const node = stack.pop();
      if (node.depth >= maxDepth) continue;
      // Defensive make/buy guard: a bought-out part is terminal — it keeps the
      // demand its parent added, but we never cascade it into raw material.
      if (buyParts && buyParts.has(node.part)) continue;
      const kids = children.get(node.part);
      if (!kids) continue;
      for (const k of kids) {
        const m = node.mult * k.qty;
        if (!(m > 0)) continue;
        let bucket = pipeline.get(k.child);
        if (!bucket) { bucket = new Map(); pipeline.set(k.child, bucket); }
        for (const [wk, qty] of rootWeeks) bucket.set(wk, (bucket.get(wk) || 0) + qty * m);
        exploded += 1;
        if (!node.seen.has(k.child)) {
          const seen = new Set(node.seen);
          seen.add(k.child);
          stack.push({ part: k.child, mult: m, depth: node.depth + 1, seen });
        }
      }
    }
  }
  return { exploded };
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
