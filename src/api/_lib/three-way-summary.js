// The running score, across orders.
//
// The per-order panel answers "did this one go right". The MODE DECISION —
// whether to let Anvil process sales orders at all — turns on a different
// question: across a month of our own orders, how often is Anvil wrong, and
// how often is the process we have today already wrong. That needs the whole
// set, not one of them.
//
// Pure. The caller does the fetching.

import { scoreAdjudications, VERDICT, isDecidable } from "./three-way-adjudicate.js";

// POOL THE FIELDS. Do not average the rates.
//
// This is the whole correctness of the thing. Averaging each order's rate
// weights a two-field order exactly as heavily as a forty-field one, so a
// single tiny order that went wrong can swamp a month of large ones that went
// right — or hide one. The honest figure counts every decidable field once,
// wherever it came from, which is what scoreAdjudications already does when
// handed the lot.
export const summariseReports = (perOrder) => {
  const reports = (perOrder || []).filter((r) => r && r.report);
  const allFields = reports.flatMap((r) => [
    ...(r.report.header || []),
    ...(r.report.lines || []).flatMap((l) => l.fields || []),
  ]);
  const score = scoreAdjudications(allFields);

  // Per-order rows, so a bad aggregate can be traced to the orders that made
  // it bad. A rate with nothing behind it is a number somebody has to take on
  // trust, and nobody should have to.
  const orders = reports.map((r) => {
    const fields = [
      ...(r.report.header || []),
      ...(r.report.lines || []).flatMap((l) => l.fields || []),
    ];
    const s = scoreAdjudications(fields);
    return {
      order_id: r.order_id,
      po_number: r.po_number ?? null,
      decidable: s.decidable,
      anvil_error_rate: s.anvil_error_rate,
      process_deviation_rate: s.process_deviation_rate,
      both_deviated: r.report.both_deviated || [],
      missing_from_erp: r.report.missing_from_erp || 0,
      erp_only: (r.report.erp_only || []).length,
    };
  });

  // Which fields actually go wrong, pooled. "Anvil is wrong 4% of the time" is
  // a number; "the quantity is what goes wrong" is somewhere to start.
  const byField = new Map();
  for (const f of allFields) {
    if (!f?.key || !isDecidable(f.verdict)) continue;
    const row = byField.get(f.key) || { field: f.key, decidable: 0, anvil_wrong: 0, process_wrong: 0, both: 0 };
    row.decidable += 1;
    if (f.verdict === VERDICT.ANVIL_WRONG || f.verdict === VERDICT.BOTH_DEVIATE || f.verdict === VERDICT.ALL_DIFFER) row.anvil_wrong += 1;
    if (f.verdict === VERDICT.ANVIL_CORRECT || f.verdict === VERDICT.BOTH_DEVIATE || f.verdict === VERDICT.ALL_DIFFER) row.process_wrong += 1;
    if (f.verdict === VERDICT.BOTH_DEVIATE) row.both += 1;
    byField.set(f.key, row);
  }

  return {
    orders_compared: reports.length,
    score,
    orders,
    // Worst first: the field most often disagreed on, by either party.
    by_field: [...byField.values()].sort(
      (a, b) => (b.anvil_wrong + b.process_wrong) - (a.anvil_wrong + a.process_wrong),
    ),
    // Aggregated because they are the findings a two-way comparison cannot
    // make, and one of them appearing anywhere in a month is worth a look.
    both_deviated_orders: orders.filter((o) => o.both_deviated.length).length,
    orders_with_missing_lines: orders.filter((o) => o.missing_from_erp > 0).length,
    orders_with_extra_erp_lines: orders.filter((o) => o.erp_only > 0).length,
  };
};

// Is there enough here to decide anything?
//
// A rate over four fields is arithmetic, not evidence, and putting it beside a
// mode selector invites somebody to act on it. Better to say the sample is too
// small and keep the number visible than to present it as a verdict.
//
// The floor is deliberately about DECIDABLE FIELDS rather than orders: ten
// orders of one line each carry less than one order of forty, and the mode
// decision cares about how much was actually compared.
export const MIN_DECIDABLE_FOR_CONFIDENCE = 40;

export const confidence = (summary) => {
  const n = summary?.score?.decidable || 0;
  if (n === 0) return { sufficient: false, reason: "nothing_decidable", detail: "No field could be decided yet, so there is no rate to read." };
  if (n < MIN_DECIDABLE_FOR_CONFIDENCE) {
    return {
      sufficient: false,
      reason: "small_sample",
      detail: `Only ${n} fields have been compared. The rates are shown, but a few more orders would make them worth acting on.`,
      decidable: n,
      needed: MIN_DECIDABLE_FOR_CONFIDENCE,
    };
  }
  return { sufficient: true, decidable: n };
};
