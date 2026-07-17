// Demand-history assembly helpers. See docs/RELIABILITY_DEMAND_DESIGN.md and
// migration 176_dense_history_flag.sql.
//
// The planning cron buckets demand into a sparse Map<isoWeekKey, qty> per part.
// classifyDemand only needs the length + the non-zero values, but Croston/SBA/TSB
// read the INTERVAL between non-zero weeks -- so the array must preserve true
// weekly spacing (real interior + trailing zero-weeks), not just the non-zero
// values packed together. denseHistory() rebuilds that dense grid.

import { addWeeks } from "./net-req.js";

// Dense weekly demand array of exactly `historyWeeks` entries, chronological,
// ending at `today` (this week's ISO-Monday key, "YYYY-MM-DD"). Each slot reads
// its week's qty from the sparse map (0 where absent), so inter-arrival intervals
// are real. Weeks outside the window (future, or older than the grid) are dropped
// -- training history is the last `historyWeeks` complete-through-today weeks.
export const denseHistory = (histMap, today, historyWeeks) => {
  const n = Math.max(0, Math.floor(Number(historyWeeks) || 0));
  const arr = new Array(n);
  for (let i = 0; i < n; i += 1) {
    // i=0 -> oldest week (today - (n-1)); i=n-1 -> current week (today).
    const wk = addWeeks(today, i - (n - 1));
    arr[i] = (histMap && histMap.get(wk)) || 0;
  }
  return arr;
};

// The original sparse-then-left-pad assembly, kept as the default (flag-off) path
// so existing tenants are byte-identical. Sorted non-zero weeks, left-padded with
// zeros to `historyWeeks`. Collapses interior/trailing zeros (the cadence bug).
export const sparseHistory = (histMap, historyWeeks) => {
  const n = Math.max(0, Math.floor(Number(historyWeeks) || 0));
  const keys = Array.from((histMap && histMap.keys()) || []).sort();
  const arr = keys.map((k) => histMap.get(k) || 0);
  while (arr.length < n) arr.unshift(0);
  return arr;
};
