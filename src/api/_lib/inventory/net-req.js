// Net requirement + planned-PO emit. Implements the spec formula
// from docs/INVENTORY_PLANNING_DESIGN.md section 2.8 + section 4.4.
//
//   NR_t = (forecast_t + safety_stock) - (on_hand + sum_to_t(in_transit) - sum_to_t(allocated))
//
// Plans are emitted when NR > 0 in any of the next H weeks AND
// there is no existing approved plan covering the shortage AND the
// hysteresis threshold has been met (the engine requires N consecutive
// runs reporting a shortage before triggering a planned PO, to avoid
// whiplash on lumpy items).

import { recommendOrderQty } from "./eoq.js";
import { reorderPoint } from "./safety-stock.js";

// Build the projected on-hand curve over `horizonWeeks` from the
// current position + per-week in-transit + per-week allocations.
//
// Inputs:
//   onHand:     current on-hand (numeric)
//   inTransitByWeek: Map<weekStart, qty>  (POs arriving)
//   allocatedByWeek: Map<weekStart, qty>  (allocations releasing)
//   weeks:      array of weekStart strings, in chronological order
//
// Output: array of { week, projected_oh } in the same order as weeks.
export const projectOnHand = ({ onHand, inTransitByWeek, allocatedByWeek, weeks }) => {
  let running = Number(onHand) || 0;
  const it = inTransitByWeek || new Map();
  const al = allocatedByWeek || new Map();
  return weeks.map((w) => {
    running = running + (Number(it.get(w)) || 0) - (Number(al.get(w)) || 0);
    return { week: w, projected_oh: running };
  });
};

// Compute net-requirement curve for one item.
//
// Inputs:
//   forecastByWeek: Map<weekStart, qty>  (mean forecast, total)
//   projectedOH:    array of { week, projected_oh }
//   safetyStock:    numeric
//
// Output: array of { week, projected_oh, forecast, net_req } where
// net_req > 0 means a shortage in that week.
export const computeNetReq = ({ forecastByWeek, projectedOH, safetyStock }) => {
  const ss = Number(safetyStock) || 0;
  return (projectedOH || []).map(({ week, projected_oh }) => {
    const f = Number(forecastByWeek?.get(week)) || 0;
    return {
      week,
      projected_oh,
      forecast: f,
      net_req: (f + ss) - projected_oh,
    };
  });
};

// Detect the first shortage week + total shortage in the lead-time
// window. This is what triggers the planned-PO emit.
export const findShortage = ({ netReqCurve, leadTimeWeeks }) => {
  const lt = Math.max(1, Math.ceil(Number(leadTimeWeeks) || 1));
  let firstWeekIdx = -1;
  let totalShortage = 0;
  for (let i = 0; i < (netReqCurve || []).length; i++) {
    if (netReqCurve[i].net_req > 0) {
      if (firstWeekIdx === -1) firstWeekIdx = i;
      // Sum the shortage within the lead-time response window.
      if (i < firstWeekIdx + lt) {
        totalShortage += netReqCurve[i].net_req;
      }
    }
  }
  if (firstWeekIdx === -1) return null;
  return {
    first_week_idx: firstWeekIdx,
    first_week: netReqCurve[firstWeekIdx].week,
    needed_qty: Math.max(0, totalShortage),
  };
};

// Add `n` weeks to a YYYY-MM-DD ISO week-start string and return
// the resulting YYYY-MM-DD.
const addWeeks = (weekStart, n) => {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
};

// Build a planned-PO row for upsert into `procurement_plans`.
// The rationale jsonb captures every input the operator needs to
// understand the recommendation (matches the rationale shape the
// UI's "Why?" drawer renders).
export const buildPlannedPO = ({
  partNo, shortage, leadTimeWeeks,
  forecastDecomp, position,
  weeklyForecastMean,
  coverageWeeks,
  unitCost, orderingCost, holdingCostPct,
  moq, packSize, roundingRule,
  serviceLevel,
  topOpps = [],
  hysteresisStreak = 1,
}) => {
  if (!shortage) return null;
  const lt = Math.max(1, Math.ceil(Number(leadTimeWeeks) || 1));
  const reco = recommendOrderQty({
    weeklyForecast: weeklyForecastMean,
    coverageWeeks,
    leadTimeWeeks,
    unitCost, orderingCost, holdingCostPct,
    moq, packSize, roundingRule,
  });
  const orderDate = addWeeks(shortage.first_week, -lt);
  const arrivalDate = shortage.first_week;
  const today = new Date().toISOString().slice(0, 10);
  // If the lead-time window has already closed (order_date < today),
  // we still emit but flag the rationale; the operator must expedite.
  const expedite = orderDate < today;
  return {
    tenant_id: undefined, // caller fills
    part_no: partNo,
    for_week: shortage.first_week,
    recommended_order_date: expedite ? today : orderDate,
    expected_arrival_date: arrivalDate,
    recommended_qty: Math.max(reco.recommended_qty, shortage.needed_qty),
    policy_source: reco.policy_source,
    net_requirement: shortage.needed_qty,
    rationale: {
      forecast_decomposition: forecastDecomp,
      position,
      shortage_week: shortage.first_week,
      shortage_qty: shortage.needed_qty,
      lead_time_weeks: leadTimeWeeks,
      coverage_weeks: coverageWeeks,
      service_level: serviceLevel,
      eoq_candidates: {
        wilson: reco.eoq_wilson,
        coverage: reco.coverage_qty,
        chosen: reco.policy_source,
      },
      top_opps: topOpps.slice(0, 3),
      hysteresis_streak: hysteresisStreak,
      expedite,
    },
    status: "draft",
  };
};

// Convenience: full per-item plan loop. Caller passes everything
// needed; this function returns either a planned-PO row or null.
export const planForItem = ({
  partNo, position, forecastByWeek, forecastDecompByWeek,
  inTransitByWeek, allocatedByWeek,
  weeks, safetyStockQty, leadTimeWeeks,
  weeklyForecastMean, coverageWeeks,
  unitCost, orderingCost, holdingCostPct,
  moq, packSize, roundingRule, serviceLevel,
  topOpps, hysteresisStreak,
}) => {
  const projected = projectOnHand({
    onHand: position?.on_hand_qty ?? 0,
    inTransitByWeek,
    allocatedByWeek,
    weeks,
  });
  const curve = computeNetReq({
    forecastByWeek, projectedOH: projected, safetyStock: safetyStockQty,
  });
  const shortage = findShortage({ netReqCurve: curve, leadTimeWeeks });
  if (!shortage) return { plan: null, curve };
  const plan = buildPlannedPO({
    partNo, shortage, leadTimeWeeks,
    forecastDecomp: forecastDecompByWeek?.get(shortage.first_week) || null,
    position,
    weeklyForecastMean,
    coverageWeeks,
    unitCost, orderingCost, holdingCostPct,
    moq, packSize, roundingRule,
    serviceLevel,
    topOpps,
    hysteresisStreak,
  });
  return { plan, curve, rop: reorderPoint({ ltdMean: leadTimeWeeks * weeklyForecastMean, ss: safetyStockQty }) };
};

export { addWeeks };
