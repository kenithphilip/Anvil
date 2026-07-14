// On-time-delivery (OTD) rollup — pure, no I/O (Logistics Ops P3).
//
// OTD = of the orders that carried a customer delivery commitment AND have a
// delivered shipment, how many were delivered on or before the committed date.
// The delivered date for an order is the latest customer_delivery_date across
// its DELIVERED / POD_RECEIVED shipments. Orders committed-but-not-yet-delivered
// are counted separately (open_committed) so the denominator is only settled
// orders.

const DELIVERED_STATUSES = new Set(["DELIVERED", "POD_RECEIVED"]);

export const computeOtd = (orders, shipments) => {
  const deliveredByOrder = new Map();   // order_id -> latest delivery date (ms)
  for (const sh of (shipments || [])) {
    if (!sh?.order_id || !DELIVERED_STATUSES.has(sh.status)) continue;
    const d = sh.customer_delivery_date ? Date.parse(sh.customer_delivery_date) : NaN;
    if (!Number.isFinite(d)) continue;
    const prev = deliveredByOrder.get(sh.order_id);
    if (prev == null || d > prev) deliveredByOrder.set(sh.order_id, d);
  }

  let total_delivered = 0, on_time = 0, late = 0, open_committed = 0;
  for (const o of (orders || [])) {
    if (!o?.committed_delivery_date) continue;
    const committed = Date.parse(o.committed_delivery_date);
    if (!Number.isFinite(committed)) continue;
    const delivered = deliveredByOrder.get(o.id);
    if (delivered == null) { open_committed += 1; continue; }
    total_delivered += 1;
    if (delivered <= committed) on_time += 1; else late += 1;
  }

  const otd_pct = total_delivered > 0 ? Math.round((on_time / total_delivered) * 1000) / 10 : null;
  return { total_delivered, on_time, late, open_committed, otd_pct };
};
