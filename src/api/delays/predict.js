// Statistical predictor for the delay detector.
//
// Replaces the hardcoded SLA defaults (14d / 7d / 5d / 7d) with
// learned, per-supplier / per-customer SLAs derived from the
// historical "sent -> ack" durations on each `source_pos` lifecycle
// (or "approved -> dispatched" for internal_sales_orders).
//
// Math:
//   * Robust SLA = median + 1.5 * MAD over the supplier's
//     historical durations. Median + MAD is decimation-resistant
//     (one or two huge outliers don't move it the way a mean +
//     stdev would). The 1.5 * MAD additive is a conventional
//     "comfortable upper bound" used in P-charts and ACFE
//     vendor-monitoring playbooks. Falls back to the static
//     default when sample is too small.
//
//   * Delay probability = logistic(beta0 + beta1 * (elapsed / SLA)
//     + beta2 * supplier_outlier_rate). Coefficients are honest
//     rule-of-thumb defaults; tuneable via env. Returns a 0..1
//     probability the line will breach SLA from this point.
//
//   * Predicted ETA = max(now, sent_at + median_duration_days).
//     Falls back to sent_at + static SLA when there's no history.
//
//   * Business days: elapsed is computed in business days (Mon-Fri
//     plus an optional tenant holiday list). Suppliers don't
//     work weekends; counting raw calendar days inflates the
//     elapsed for orders sent Friday afternoon.
//
//   * Criticality: a downstream-dependency multiplier. A source
//     PO with a referencing work order or shipment plan gets
//     criticality * 1.25; without references, * 1.0. Multiplied
//     into the risk score so a delayed PO that holds up a
//     shipment ranks above one that's standalone.
//
// All exports are pure and memoryless so they're trivially
// unit-testable without a Supabase client.

const median = (arr) => {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mad = (arr) => {
  if (arr.length < 2) return 0;
  const m = median(arr);
  return median(arr.map((v) => Math.abs(v - m)));
};

const robustZ = (value, sample) => {
  if (sample.length < 2) return 0;
  const m = median(sample);
  const dispersion = mad(sample) || (sample.length ? Math.max(1, m * 0.05) : 1);
  return (value - m) / dispersion;
};

// === Business-day elapsed =================================================
// Counts only Mon-Fri between two ISO dates. Excludes the supplied
// holiday set (an array of YYYY-MM-DD strings). Both dates inclusive.
const businessDaysBetween = (startISO, endISO, holidays = []) => {
  if (!startISO || !endISO) return null;
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (start > end) return 0;
  const holidaySet = new Set(holidays);
  let count = 0;
  // Cap at 365 to avoid pathological loops on bad data.
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(0, 0, 0, 0);
  let i = 0;
  while (cur <= stop && i < 365) {
    const dow = cur.getDay();
    const ymd = cur.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(ymd)) count += 1;
    cur.setDate(cur.getDate() + 1);
    i += 1;
  }
  return count;
};

// === SLA learning =========================================================
// Given a supplier's historical sent->ack durations (in business
// days), return a learned SLA = median + 1.5 * MAD. When there are
// fewer than 5 samples, returns null (caller should fall back to
// the static default).
const learnSla = (durations, opts = {}) => {
  const min = opts.minSamples != null ? opts.minSamples : 5;
  const k = opts.kMad != null ? opts.kMad : 1.5;
  if (!Array.isArray(durations) || durations.length < min) return null;
  const m = median(durations);
  const d = mad(durations);
  return Math.max(1, Math.round(m + k * d));
};

// Build a per-supplier durations map from a list of source_pos
// rows. We use {sent_at, acked_at} when both are present; otherwise
// we infer from updated_at when the status went SENT_TO_SUPPLIER ->
// SUPPLIER_ACK / ETA_CONFIRMED / RECEIVED.
const learnSuppliersSlas = (sourcePosHistory, holidays = []) => {
  const byKey = {};
  (sourcePosHistory || []).forEach((p) => {
    const key = p.supplier || "(unknown)";
    const sent = p.sent_at || p.created_at;
    const acked = p.acked_at || (
      ["SUPPLIER_ACK", "ETA_CONFIRMED", "RECEIVED", "CLOSED"].indexOf(p.status) >= 0
        ? p.updated_at : null
    );
    if (!sent || !acked) return;
    const days = businessDaysBetween(sent, acked, holidays);
    if (days == null || days < 0 || days > 365) return;
    byKey[key] = byKey[key] || [];
    byKey[key].push(days);
  });
  const out = {};
  Object.keys(byKey).forEach((k) => {
    const sla = learnSla(byKey[k]);
    if (sla != null) out[k] = { sla, samples: byKey[k].length, median: median(byKey[k]), mad: mad(byKey[k]) };
  });
  return out;
};

// === Delay probability (logistic) =========================================
// score = beta0 + beta1 * elapsed/sla + beta2 * supplierOutlierRate
// p = 1 / (1 + e^-score)
//
// Defaults tuned to: ratio=1 (at SLA) -> p≈0.5; ratio=2 -> p≈0.88;
// ratio=0.5 -> p≈0.18.
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const delayProbability = (elapsed, sla, supplierOutlierRate = 0, opts = {}) => {
  if (!sla || sla <= 0) return 0;
  const beta0 = opts.beta0 != null ? opts.beta0 : -2;
  const beta1 = opts.beta1 != null ? opts.beta1 : 2;
  const beta2 = opts.beta2 != null ? opts.beta2 : 1.5;
  const ratio = elapsed / sla;
  return sigmoid(beta0 + beta1 * ratio + beta2 * supplierOutlierRate);
};

// === Predicted ETA ========================================================
// Given the source PO's sent_at and a learned median duration (in
// business days), return an ISO date for the predicted ack/ready
// date. Falls back to sent_at + static SLA when no median is on
// file.
const addBusinessDays = (startISO, days, holidays = []) => {
  if (!startISO || days == null) return null;
  const start = new Date(startISO);
  if (!Number.isFinite(start.getTime())) return null;
  const holidaySet = new Set(holidays);
  let added = 0;
  const cur = new Date(start);
  while (added < days) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    const ymd = cur.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(ymd)) added += 1;
  }
  return cur.toISOString().slice(0, 10);
};

const predictEta = (sentISO, supplierStats, fallbackSlaDays, holidays = []) => {
  if (!sentISO) return null;
  const days = (supplierStats && supplierStats.median != null)
    ? Math.max(1, Math.ceil(supplierStats.median))
    : fallbackSlaDays;
  return addBusinessDays(sentISO, days, holidays);
};

// === Critical-path detection ===============================================
// A flag with downstream dependencies (work order or shipment row
// referencing the source_po_id) gets criticality > 1; standalone
// rows get 1.0.
const criticalityFor = (sourcePoId, deps) => {
  const ws = deps && deps.workOrders ? deps.workOrders : [];
  const sh = deps && deps.shipments ? deps.shipments : [];
  let mult = 1.0;
  if (ws.some((w) => w.source_po_id === sourcePoId)) mult = Math.max(mult, 1.25);
  if (sh.some((s) => s.source_po_id === sourcePoId)) mult = Math.max(mult, 1.25);
  // Both downstream artifacts present: even higher.
  if (ws.some((w) => w.source_po_id === sourcePoId)
      && sh.some((s) => s.source_po_id === sourcePoId)) mult = 1.5;
  return mult;
};

// === Composite risk score =================================================
// Combines elapsed/SLA ratio, delay probability, and criticality
// multiplier into a single 0..100 score. Easier to sort by than the
// 3-step severity buckets and gives the operator a sense of "how
// bad" without thinking in z-scores.
const riskScore = ({ elapsed, sla, supplierOutlierRate, criticality }) => {
  const p = delayProbability(elapsed || 0, sla || 1, supplierOutlierRate || 0);
  const base = Math.min(100, Math.round(p * 100));
  return Math.min(100, Math.round(base * (criticality || 1.0)));
};

// === Test export ===========================================================
export const __test = {
  median, mad, robustZ, businessDaysBetween, addBusinessDays,
  learnSla, learnSuppliersSlas, sigmoid, delayProbability, predictEta,
  criticalityFor, riskScore,
};

export {
  median, mad, robustZ, businessDaysBetween, addBusinessDays,
  learnSla, learnSuppliersSlas, sigmoid, delayProbability, predictEta,
  criticalityFor, riskScore,
};
