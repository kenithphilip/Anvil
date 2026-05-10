// Order-quantity policies: Wilson EOQ + coverage-period policy.
// Both are bounded below by MOQ and rounded to the supplier's pack
// size. See docs/INVENTORY_PLANNING_DESIGN.md section 2.4.

// EOQ (Wilson formula): Q* = sqrt(2 * D * S / H)
//   D = annual demand (units / year)
//   S = fixed cost per order (currency)
//   H = annual holding cost per unit (currency / unit / year)
// Holding cost is typically expressed as a fraction of unit cost
// per year: H = unitCost * holdingCostPct.
export const eoqWilson = ({ annualDemand, orderingCost, unitCost, holdingCostPct }) => {
  const d = Math.max(0, Number(annualDemand) || 0);
  const s = Math.max(0, Number(orderingCost) || 0);
  const h = (Number(unitCost) || 0) * Math.max(0, Number(holdingCostPct) || 0);
  if (d <= 0 || s <= 0 || h <= 0) return 0;
  return Math.sqrt((2 * d * s) / h);
};

// Coverage-period policy: order enough to cover N weeks of forecast
// demand. The default for long-lead items is one full lead-time
// cycle plus margin (12 weeks for ATD/Timer per the design).
export const eoqCoverage = ({ weeklyForecast, coverageWeeks }) => {
  const f = Math.max(0, Number(weeklyForecast) || 0);
  const w = Math.max(0, Number(coverageWeeks) || 0);
  return f * w;
};

// Snap an unrounded order quantity to the supplier's MOQ + pack-size
// constraints. Always returns an integer >= MOQ when the unrounded
// qty is positive.
//
//   moq         : minimum the supplier will accept for one PO
//   packSize    : multiple the supplier requires (e.g. 50/case)
//   roundingRule: 'ceil' | 'round' | 'floor' (default 'ceil' to
//                 cover the shortage; never order less than needed)
export const snapToConstraints = (qty, { moq = 1, packSize = 1, roundingRule = "ceil" } = {}) => {
  const q = Math.max(0, Number(qty) || 0);
  if (q <= 0) return 0;
  const mo = Math.max(1, Number(moq) || 1);
  const ps = Math.max(1, Number(packSize) || 1);
  const adjusted = Math.max(q, mo);
  const rounder = roundingRule === "floor" ? Math.floor
                : roundingRule === "round" ? Math.round
                : Math.ceil;
  const inPacks = rounder(adjusted / ps);
  return inPacks * ps;
};

// The selector. Given an item + tenant config + forecast, returns
// both candidate quantities so the UI can show the operator
// side-by-side. Default selection: coverage for long-lead items
// (lead_time >= 6 weeks), EOQ otherwise. The procurement_plans row
// records which one was used via `policy_source`.
export const recommendOrderQty = ({
  weeklyForecast, coverageWeeks, leadTimeWeeks,
  unitCost, orderingCost, holdingCostPct,
  moq = 1, packSize = 1, roundingRule = "ceil",
}) => {
  const annualDemand = (Number(weeklyForecast) || 0) * 52;
  const wilson = eoqWilson({ annualDemand, orderingCost, unitCost, holdingCostPct });
  const coverage = eoqCoverage({ weeklyForecast, coverageWeeks });
  const wilsonSnapped = snapToConstraints(wilson, { moq, packSize, roundingRule });
  const coverageSnapped = snapToConstraints(coverage, { moq, packSize, roundingRule });
  const longLead = (Number(leadTimeWeeks) || 0) >= 6;
  const policy = longLead ? "rule_based_coverage" : "rule_based_eoq";
  const recommended = longLead ? coverageSnapped : wilsonSnapped;
  return {
    recommended_qty: recommended,
    policy_source: policy,
    eoq_wilson: wilsonSnapped,
    coverage_qty: coverageSnapped,
    rationale: { annualDemand, weeklyForecast, coverageWeeks, leadTimeWeeks, moq, packSize, unitCost, orderingCost, holdingCostPct },
  };
};
