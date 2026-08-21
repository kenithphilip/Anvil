// What does this deviation actually cost?
//
// The reconciler has always reported a PERCENTAGE — "PO 1250 vs quote 1180
// (+5.93%)" — and nobody approves a purchase order on a percentage. The
// question at the approval gate is how many rupees are at stake, and it has
// never been answered anywhere in the product.
//
// This needs no new data. po_rate, quote_rate and po_qty are already computed
// per line and now ride on each flag; the arithmetic below is the whole gap.
//
// PURE. No I/O. The caller supplies a persisted result.quoteReconciliation.

const n = (v) => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const r2 = (x) => Math.round(x * 100) / 100;

// THREE DIFFERENT NUMBERS, DELIBERATELY NOT SUMMED INTO ONE.
//
// They mean different things and adding them would produce a figure that is
// true of nothing:
//
//   priced      lines quoted AND ordered at a different rate. This is the
//               real over/under against a price both sides agreed.
//               SIGN: positive = the PO pays MORE than we quoted (the
//               customer will dispute it); negative = the PO pays LESS than
//               we quoted (we are short, and nobody noticed).
//
//   unmatched   lines on the PO that no quote covers. Not a delta — there is
//               no agreed price to differ from — but EXPOSURE: the full line
//               value is being sold at a price nobody checked.
//
//   notOrdered  lines quoted and not ordered. Revenue not taken, not an
//               overcharge. Reported so a short PO is visible; never netted
//               against the others.
export const deviationValue = (recon, opts = {}) => {
  const currency = opts.currency || null;
  const flags = Array.isArray(recon?.flags) ? recon.flags : [];
  const notOrderedRows = Array.isArray(recon?.quoted_not_ordered) ? recon.quoted_not_ordered : [];

  const priced = { count: 0, amount: 0, lines: [] };
  const unmatched = { count: 0, amount: 0, lines: [] };
  // Flags whose money could not be computed — a missing qty, a missing rate.
  // Counted rather than silently dropped: "₹0 at risk" and "we could not
  // price 6 of the 8 exceptions" are very different statements.
  const unpriceable = [];

  for (const f of flags) {
    const poRate = n(f.po_rate);
    const quoteRate = n(f.quote_rate);
    const qty = n(f.po_qty);

    if (f.verdict === "price_mismatch") {
      if (poRate == null || quoteRate == null || qty == null) { unpriceable.push({ part_no: f.part_no || null, verdict: f.verdict, missing: qty == null ? "quantity" : "rate" }); continue; }
      const amount = r2((poRate - quoteRate) * qty);
      priced.count += 1;
      priced.amount = r2(priced.amount + amount);
      priced.lines.push({
        part_no: f.part_no || null, po_rate: poRate, quote_rate: quoteRate,
        qty, amount, price_delta_pct: n(f.price_delta_pct),
        source_quote_number: f.source_quote_number || null,
      });
      continue;
    }

    if (f.verdict === "unmatched") {
      if (poRate == null || qty == null) { unpriceable.push({ part_no: f.part_no || null, verdict: f.verdict, missing: qty == null ? "quantity" : "rate" }); continue; }
      const amount = r2(poRate * qty);
      unmatched.count += 1;
      unmatched.amount = r2(unmatched.amount + amount);
      unmatched.lines.push({ part_no: f.part_no || null, po_rate: poRate, qty, amount });
      continue;
    }
    // description_mismatch and the header verdicts carry no money.
  }

  const notOrdered = { count: 0, amount: 0 };
  for (const q of notOrderedRows) {
    const rate = n(q.unit_price ?? q.discounted_unit_price ?? q.listed_unit_price);
    const qty = n(q.qty);
    if (rate == null || qty == null) continue;
    notOrdered.count += 1;
    notOrdered.amount = r2(notOrdered.amount + rate * qty);
  }

  // Sort worst-first by absolute exposure — the approver reads the top of the
  // list, so it must be the line that matters most, not the first one parsed.
  priced.lines.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  unmatched.lines.sort((a, b) => b.amount - a.amount);

  return {
    currency,
    priced,
    unmatched,
    not_ordered: notOrdered,
    unpriceable,
    // The single figure worth putting on a button: the over/under against
    // prices both sides agreed. NOT including unmatched exposure, which is a
    // different question, and never including not_ordered.
    net: priced.amount,
    // "worth reviewing" is priced + unmatched: both are money moving on this
    // PO that no one has signed off.
    at_stake: r2(Math.abs(priced.amount) + unmatched.amount),
    any: priced.count > 0 || unmatched.count > 0,
  };
};

// Is it safe to state a single figure for this order?
//
// This codebase has form for summing across currencies and printing the total
// with a rupee sign. An order whose lines disagree on currency gets no total —
// the caller shows the per-line deltas instead and says why.
export const currencyOf = (order) => {
  const so = order?.result?.salesOrder || {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems : [];
  const seen = new Set();
  for (const l of lines) {
    const c = l?.currency || l?.currency_code;
    if (c) seen.add(String(c).toUpperCase());
  }
  const header = so.currency ? String(so.currency).toUpperCase() : null;
  if (seen.size > 1) return { currency: null, comparable: false, reason: "mixed_line_currencies" };
  const one = seen.size === 1 ? [...seen][0] : null;
  if (one && header && one !== header) return { currency: null, comparable: false, reason: "line_header_currency_disagree" };
  return { currency: one || header || "INR", comparable: true, reason: null };
};
