// The money on one sales-order line, as every export of the order prints it.
//
// The Excel export and the SO PDF used to read different fields. The PDF read
// discounted_unit_price first, and the quote reconciler wrote the QUOTE's rate
// into that field. So on a line where the PO and the quote disagree, the PDF
// printed the quote's rate and the Excel printed the PO's, and the two
// documents for one order did not add up to the same total.
//
// The PO rate is the customer's commitment, so it is the rate. The quote's rate
// is reference data. It rides on quote_unit_price and _match.quote_rate, and a
// difference is a reconciliation flag for a person to decide, never a silent
// repricing.
//
// PURE. No I/O.

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const first = (...xs) => {
  for (const x of xs) if (x !== undefined && x !== null && x !== "") return x;
  return null;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The rate the PO itself carries, or null when it printed none. These are the
// fields the extractor, quote convert, a variance line and an operator edit
// write. discounted_unit_price is deliberately NOT one of them: on an order
// line only the reconciler writes it, so reading it here would read the
// reconciler's own output back as the customer's rate.
export const poLineRate = (ln) => num(first(ln?.rate, ln?.unitPrice, ln?.unit_price, ln?.ex_price));

export const soLineQty = (ln) => num(first(ln?.qty, ln?.quantity)) ?? 0;

// The rate an export prints. discounted_unit_price is the fallback for a line
// whose PO printed no rate, which the reconciler fills from the quote.
export const soLineRate = (ln) => {
  const po = poLineRate(ln);
  if (po != null) return po;
  return num(ln?.discounted_unit_price) ?? 0;
};

// { qty, rate, amount }. The amount is ex-tax, Qty x Rate, as the SO PDF has
// always printed it. A printed line amount is not used: an extracted `amount`
// may include tax, and an export that takes it would disagree with one that
// does not.
export const soLineMoney = (ln) => {
  const qty = soLineQty(ln);
  const rate = soLineRate(ln);
  return { qty, rate, amount: round2(qty * rate) };
};

export const soLinesTotal = (lines) =>
  round2((Array.isArray(lines) ? lines : []).reduce((s, ln) => s + soLineMoney(ln).amount, 0));
