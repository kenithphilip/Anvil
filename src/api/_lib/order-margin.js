// One margin calculation for an order, in one place.
//
// There were two, and only one of them worked.
//
//   _lib/approval-evaluator.js computed it correctly — selling from
//   result.salesOrder.lineItems, landed cost from
//   result.priceComposition.lineItems — used it to decide whether an order
//   needed approval at all, and then discarded it.
//
//   admin/quote_approvals.js, the endpoint that renders the approvals QUEUE,
//   derived it a second way: `Number(so.marginPct ?? so.margin_pct)`. Neither
//   spelling is written by anything, anywhere. Its comment reads "margin is
//   read defensively because the field name drifts between marginPct (camel)
//   and margin_pct (snake) across older orders" — the author believed the
//   field existed in one of two forms. It exists in neither.
//
// So the approver's margin column was always blank, while the code to compute
// it correctly sat in the file that creates the very row being displayed.
//
// Exported here so the next consumer inherits the working one rather than
// inventing a third.

// Selling total and landed cost for an order, matched line by line.
//
// Returns null rather than 0 when it cannot be computed: an order with no
// price composition has an UNKNOWN margin, and 0% would read as a disaster.
// The caller decides how to show "not costed".
export const orderMargin = (order) => {
  const so = order?.result?.salesOrder || {};
  const pc = order?.result?.priceComposition || {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems : [];
  const compLines = Array.isArray(pc.lineItems) ? pc.lineItems : [];
  if (!lines.length || !compLines.length) return null;

  const compByPart = {};
  for (const r of compLines) {
    const k = String(r.partNumber || r.partNo || "").toUpperCase();
    if (k) compByPart[k] = r;
  }

  let landed = 0;
  let selling = 0;
  let matched = 0;
  for (const li of lines) {
    const k = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
    const m = compByPart[k];
    const qty = Number(li.qty) || 0;
    const rate = Number(li.rate) || 0;
    selling += qty * rate;
    if (m) {
      matched += 1;
      const unit = Number(m.landedCostINR != null ? m.landedCostINR : m.unitInr) || 0;
      landed += qty * unit;
    }
  }
  if (!matched || selling <= 0) return null;

  return {
    selling,
    landed,
    marginPct: ((selling - landed) / selling) * 100,
    // How much of the order the cost side actually covered. A margin computed
    // from 2 of 40 costed lines is not the order's margin, and the caller
    // needs to be able to say so rather than presenting it as complete.
    linesMatched: matched,
    linesTotal: lines.length,
    partial: matched < lines.length,
  };
};

// Just the percentage, for callers that only gate on it.
export const orderMarginPct = (order) => {
  const m = orderMargin(order);
  return m ? m.marginPct : null;
};
