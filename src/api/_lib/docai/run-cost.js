// Per-extraction cost accumulator + hard cap (Wave 1.4 / #18).
//
// The per-day per-adapter cost guard (cost_guard.js) protects the
// tenant from a runaway month: if Claude is configured with a 50
// call/day cap, the dispatcher stops dispatching after the 50th
// successful Claude call regardless of which extraction is in
// flight. It does NOT protect against a single extraction running
// away: a 70-page PDF chunked into 14 pieces, each calling Claude
// for $0.022, burns $0.31 in one POST. The cap is per-day, not
// per-run, so the operator only finds out about it tomorrow when
// the meter pegs.
//
// This module adds a per-extraction budget. The pipeline creates
// one accumulator before dispatch and threads it down through
// chunkedExtract -> dispatchExtract -> per-adapter loop. Each
// adapter call checks `wouldExceed(adapter)` before firing; if the
// cap is already reached or the next call would breach it, the
// adapter is skipped with status='skipped_over_run_budget' so the
// audit trail is explicit. After a successful call, the
// accumulator records the estimated cost.
//
// The cap is tenant-tunable via
//   tenant_settings.docai_per_extraction_cost_cap_usd
// Default DEFAULT_PER_EXTRACTION_CAP_USD = $1.00. A 70-page
// Hyundai PO using the cheap Gemini-first chain costs ~$0.05; the
// Sonnet fallback path costs ~$0.30. $1 is roughly 4-5x the worst
// single extraction we have seen in production.
//
// Costs are estimated using cost_guard.DEFAULT_COST_USD which the
// operator overrides via COST_USD_* env vars per adapter. The
// accumulator never charges actual money: it's a soft estimate
// used as a circuit breaker.

import { __consts__ as costConsts } from "../cost_guard.js";

export const DEFAULT_PER_EXTRACTION_CAP_USD = 1.0;
export const MAX_PER_EXTRACTION_CAP_USD = 50.0;     // sanity ceiling

const resolveCap = (capUsd) => {
  const n = Number(capUsd);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_EXTRACTION_CAP_USD;
  if (n > MAX_PER_EXTRACTION_CAP_USD) return MAX_PER_EXTRACTION_CAP_USD;
  return n;
};

export const estimatedCostFor = (adapter) => {
  const tbl = costConsts?.DEFAULT_COST_USD || {};
  return Number(tbl[adapter] || 0);
};

// Build a per-run accumulator.
//
// .cap                        the hard limit in USD
// .totalUsd                   accumulated cost so far
// .calls                      [{ adapter, costUsd, at }]
// .wouldExceed(adapter,perCallUsd?)
//                             true if adding this call would breach
//                             the cap. perCallUsd overrides the
//                             default cost (used in tests).
// .add(adapter, perCallUsd?)  record a successful call. Returns
//                             the new total.
// .skip(adapter, reason)      record a skipped call (for telemetry).
// .hasExceeded()              true if totalUsd >= cap.
// .summary()                  jsonb-friendly snapshot for the
//                             extraction_runs.cost_summary column.
export const createRunCostAccumulator = (capUsd) => {
  const cap = resolveCap(capUsd);
  const calls = [];
  const skipped = [];
  let total = 0;
  const self = {
    cap,
    get totalUsd() { return total; },
    get calls() { return calls.slice(); },
    get skipped() { return skipped.slice(); },
    estimatedCostFor,
    wouldExceed(adapter, perCallUsd) {
      const cost = Number.isFinite(perCallUsd) ? Number(perCallUsd) : estimatedCostFor(adapter);
      return total + cost > cap + 1e-9;     // float tolerance
    },
    add(adapter, perCallUsd) {
      const cost = Number.isFinite(perCallUsd) ? Number(perCallUsd) : estimatedCostFor(adapter);
      total += cost;
      calls.push({ adapter, costUsd: cost, at: new Date().toISOString() });
      return total;
    },
    skip(adapter, reason) {
      skipped.push({ adapter, reason, at: new Date().toISOString() });
    },
    hasExceeded() { return total >= cap; },
    summary() {
      return {
        cap_usd: cap,
        total_usd: Number(total.toFixed(6)),
        breached: total > cap + 1e-9,
        call_count: calls.length,
        skipped_count: skipped.length,
        calls: calls.slice(),
        skipped: skipped.slice(),
      };
    },
  };
  return self;
};

export const __test = { resolveCap };
