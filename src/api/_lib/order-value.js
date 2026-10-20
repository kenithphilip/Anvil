// What an order is worth.
//
// `orders` has NO monetary column. Not total_value, not grand_total — the
// money lives inside the extracted `result.salesOrder` payload, and every
// consumer that needs it digs it out of there (see _lib/invoicing.js, which is
// where this derivation comes from).
//
// winloss.js selected a `total_value` column that does not exist, which made
// PostgREST reject the whole query and took the entire nightly analytics
// refresh down with it. Centralising the derivation means the next consumer
// does not have to rediscover where an order's value actually lives.

import { computeLineTotals } from "./line-totals.js";

/**
 * Grand total of an order, from its extracted sales-order payload.
 *
 * Prefers a stated total, falls back to summing line items, and finally to the
 * linked opportunity's INR amount when the payload carries no money at all
 * (an order created before extraction ran, or from a PO with no prices).
 *
 * Returns 0 rather than null: callers accumulate this into rollups, and a null
 * would poison a running sum.
 */
export const orderGrandTotal = (order, opportunity = null) => {
  const so = order?.result?.salesOrder || {};
  const items = Array.isArray(so.lineItems) ? so.lineItems : [];
  const stated = Number(so.grandTotal ?? so.total);
  if (Number.isFinite(stated) && stated > 0) return stated;

  const subtotal = Number(so.subtotal) || items.reduce(
    (s, it) => s + (Number(it?.total) || (Number(it?.rate) || 0) * (Number(it?.quantity) || 0)),
    0,
  );
  const tax = Number(so.taxTotal ?? so.gstTotal) || 0;
  const derived = subtotal + tax;
  if (derived > 0) return derived;

  const oppAmount = Number(opportunity?.amount_inr);
  return Number.isFinite(oppAmount) && oppAmount > 0 ? oppAmount : 0;
};

// The value a person reads on a screen, the same on every screen and endpoint
// that shows one order (plan R-M1): the PO's printed grand total, else the sum
// of its line totals from computeLineTotals(), the math the workspace grid and
// footer use. A scanned PO often prints no grand total; the workspace summed
// its lines and the lists showed nothing. Null, not 0, when the order has no
// grand total and no priced line, so a screen can say "not priced".
// lines: the lines to sum. Default: the order's own. The workspace passes its
// unsaved edits.
// shortcut: orderGrandTotal above (the win/loss rollups) still derives its
// own figure; upgrade when the rollups should match the screens.
export const orderValue = (order, lines = order?.result?.salesOrder?.lineItems) => {
  const grand = Number(order?.result?.salesOrder?.grandTotal);
  if (grand) return grand;
  const sum = (Array.isArray(lines) ? lines : []).reduce((s, ln) => s + computeLineTotals(ln).lineTotal, 0);
  return sum ? Math.round(sum * 100) / 100 : null;
};
