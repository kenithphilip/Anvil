// Reliability-driven safety-stock floor from field failure / replacement events
// (bridge step 4b). See docs/RELIABILITY_DEMAND_DESIGN.md.
//
// The consumption BLEND (buildHistory in inventory-planning-weekly.js) already
// folds failure_events.replaced_qty into the trained demand history, so it flows
// into baselineMean -> reorder_point and covers the EXPECTED replacement demand.
// This module adds the distinct, missing piece: a minimum SAFETY buffer sized to
// the VARIABILITY of an intermittent failure process, so a critical part that
// rarely sells but fails unpredictably still carries a buffer even when its
// schedule-based statistical safety stock is near zero.
//
// It is NON-double-counting by construction: the caller folds reliabilityFloor()
// into safetyStock()'s max(statSS, projectFloor, reliabilityFloor), so it only
// raises safety stock when it exceeds the other candidates -- it never stacks.

import { standardNormalInverse } from "./safety-stock.js";

// Average weekly replacement rate (lambda) over the observation window.
export const weeklyFailureRate = ({ totalReplacedQty, windowWeeks }) => {
  const w = Number(windowWeeks) || 0;
  if (w <= 0) return 0;
  const q = Number(totalReplacedQty);
  return Number.isFinite(q) && q > 0 ? q / w : 0;
};

// z(alpha) * sqrt(lambda * leadTimeWeeks): the service-level-scaled Poisson
// standard deviation of failure/replacement arrivals during one lead time.
// Returns 0 when there is no failure signal or no lead time (so an unmatched or
// never-failing part contributes nothing to the max()).
export const reliabilityFloor = ({ totalReplacedQty, windowWeeks, leadTimeWeeks, alpha }) => {
  const lambda = weeklyFailureRate({ totalReplacedQty, windowWeeks });
  const lt = Number(leadTimeWeeks);
  if (lambda <= 0 || !Number.isFinite(lt) || lt <= 0) return 0;
  const expDuringLeadTime = lambda * lt;
  const zAlpha = standardNormalInverse(alpha);
  if (!Number.isFinite(zAlpha) || zAlpha <= 0) return 0;
  return zAlpha * Math.sqrt(expDuringLeadTime);
};
