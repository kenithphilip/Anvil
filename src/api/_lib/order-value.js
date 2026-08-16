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
