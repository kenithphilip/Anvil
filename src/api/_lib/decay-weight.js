// Decay-weighted confidence (Wave CM 3.2).
//
// A correction the operator confirmed yesterday says more about
// today's PO than a correction from 11 months ago. Customer
// catalogues drift; part numbers get renamed; aliases evolve.
// The active-learning prior should weigh recent corrections
// more than ancient ones.
//
// This module provides:
//
//   - halfLifeDecay(daysSince, halfLifeDays) -> 0..1 weight.
//     Standard exponential decay: weight = 2^(-daysSince / halfLifeDays).
//     90 days half-life by default (configurable per-tenant).
//
//   - weightedCorrections(corrections, opts) -> [{...row, weight}]
//     Annotates a list of learned_corrections rows with their
//     current weight. Callers (customer-hints priming, the
//     consensus engine) sort by weight desc and truncate to
//     the top-N for the prompt.
//
//   - topKWeighted(corrections, k, opts) -> top-K by weight.
//     Convenience for the prompt-priming path where we only
//     want the highest-signal corrections in the system prompt.
//
// Pure: no I/O, no DB calls. Caller supplies the rows.

const DEFAULT_HALF_LIFE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Pure exponential decay. daysSince=0 -> weight=1.
// daysSince=halfLifeDays -> weight=0.5.
// daysSince=2*halfLifeDays -> weight=0.25, and so on.
export const halfLifeDecay = (daysSince, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) => {
  const d = Math.max(0, Number(daysSince) || 0);
  const h = Number(halfLifeDays) > 0 ? Number(halfLifeDays) : DEFAULT_HALF_LIFE_DAYS;
  return Math.pow(2, -d / h);
};

export const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const ta = a instanceof Date ? a.getTime() : Date.parse(a);
  const tb = b instanceof Date ? b.getTime() : Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.abs(ta - tb) / MS_PER_DAY;
};

// Annotate each correction row with a current weight. Reads
// row.created_at as the timestamp; missing dates get weight=0
// (we can't trust un-dated rows). Caller may pass `now` for
// determinism in tests.
export const weightedCorrections = (corrections, opts = {}) => {
  if (!Array.isArray(corrections)) return [];
  const now = opts.now instanceof Date ? opts.now : new Date();
  const halfLife = Number(opts.halfLifeDays) > 0 ? Number(opts.halfLifeDays) : DEFAULT_HALF_LIFE_DAYS;
  return corrections.map((row) => {
    if (!row?.created_at) return { ...row, weight: 0 };
    const days = daysBetween(row.created_at, now);
    const weight = halfLifeDecay(days, halfLife);
    return { ...row, weight, days_since: days };
  });
};

// Return the top-K corrections by weight. Stable secondary sort
// on created_at desc so two same-day corrections come back in
// document order.
export const topKWeighted = (corrections, k = 10, opts = {}) => {
  const annotated = weightedCorrections(corrections, opts);
  annotated.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });
  return annotated.slice(0, Number(k) || 10);
};

// Apply the decay to a numeric field, returning the
// "effective" value for ranking purposes. Used by the
// consensus engine to weight occurrences by recency.
export const decayedScore = (rawScore, createdAt, opts = {}) => {
  if (!createdAt) return Number(rawScore) || 0;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = daysBetween(createdAt, now);
  const weight = halfLifeDecay(days, opts.halfLifeDays);
  return (Number(rawScore) || 0) * weight;
};

export const __test = { DEFAULT_HALF_LIFE_DAYS };
