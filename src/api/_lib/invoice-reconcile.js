// Does the invoice we are about to send agree with the PO the customer sent?
//
// WHY IT MATTERS COMMERCIALLY. A large buyer books an incoming invoice against
// the purchase order it was raised for. If the lines, quantities or prices do
// not agree with that PO, their goods receipt is not raised — and no GRN means
// no payment. Every discrepancy below is a reason a receipt gets rejected.
//
// PURE. No I/O: orders/reconcile_invoice.js does the fetching. Same division
// as quote-reconcile.js, and it shares that module's primitives via
// line-compare.js rather than re-deriving how a part code is normalised.
//
// PARTIAL INVOICING IS NORMAL, AND IS THE WHOLE DIFFICULTY.
//
// A multi-shipment order is invoiced in pieces, so an invoice for fewer units
// than the PO is not a defect. The only quantity question worth asking is
// CUMULATIVE: across this invoice and every other live invoice for the order,
// have we billed more than was ordered? That is why this takes `priorLines`
// and not merely the invoice under test.
//
// Price is the opposite: an invoice at a rate the PO does not carry is always
// a problem, whatever the quantity.

import {
  lineKey, linePartNo, lineQty, lineRate, lineDesc, lineAmount,
  indexByPart, comparePrice, compareDescription, round2, num,
} from "./line-compare.js";

// Verdicts, worst first. Ordering is meaningful: a line can be wrong in more
// than one way and the operator should see the reason a receipt would actually
// be rejected on, not whichever check happened to run first.
export const VERDICTS = Object.freeze([
  "not_on_po",        // invoiced something the PO never ordered
  "qty_over_ordered", // cumulative invoiced qty exceeds the ordered qty
  "price_mismatch",   // invoiced at a rate the PO does not carry
  "description_mismatch",
  "matched",
]);

// Statuses whose quantities count as ALREADY BILLED.
//
// 'draft' does not: an unsent invoice has not been billed to anyone, and
// counting it would make a second draft look like over-invoicing against the
// first. 'void' does not: it has been withdrawn. Everything else has reached
// the customer in some form. (invoices.status check constraint, migration 012:
// draft, sent, partial, paid, overdue, void.)
export const COUNTED_INVOICE_STATUSES = Object.freeze(["sent", "partial", "paid", "overdue"]);

export const countsTowardBilled = (invoice) => {
  if (!invoice) return false;
  if (invoice.voided_at) return false;
  return COUNTED_INVOICE_STATUSES.includes(String(invoice.status || "").toLowerCase());
};

// Sum invoiced quantity per part across a set of already-issued invoices.
export const billedQtyByPart = (priorInvoices) => {
  const billed = new Map();
  for (const inv of priorInvoices || []) {
    if (!countsTowardBilled(inv)) continue;
    for (const ln of Array.isArray(inv.line_items) ? inv.line_items : []) {
      const key = lineKey(ln);
      if (!key) continue;
      const q = lineQty(ln);
      if (q == null) continue;
      billed.set(key, round2((billed.get(key) || 0) + Number(q)));
    }
  }
  return billed;
};

// opts.priceTolerancePct — allowed |invoice rate - PO rate| before flagging.
// Defaults to 0, deliberately: the quote hop tolerates 0.5% because a quote is
// a negotiation, but an invoice is a demand for a specific sum and a buyer's
// three-way match is usually exact. A tenant that wants slack must ask for it.
export const reconcileInvoiceAgainstOrder = (orderLines, invoiceLines, priorInvoices = [], opts = {}) => {
  const tol = opts.priceTolerancePct != null ? Number(opts.priceTolerancePct) : 0;
  const { byPart: poByPart, ambiguous } = indexByPart(orderLines);
  const billed = billedQtyByPart(priorInvoices);

  const summary = {
    total: 0, matched: 0,
    not_on_po: 0, qty_over_ordered: 0, price_mismatch: 0, description_mismatch: 0,
  };
  const invoicedKeys = new Set();

  const lines = (invoiceLines || []).map((ln) => {
    summary.total += 1;
    const key = lineKey(ln);
    const po = key ? poByPart.get(key) : null;
    const invQty = lineQty(ln);
    const invRate = lineRate(ln);

    if (!po) {
      // The buyer cannot receive what they did not order. Always a blocker.
      summary.not_on_po += 1;
      return {
        part_no: linePartNo(ln), verdict: "not_on_po", blocking: true,
        invoice_qty: invQty, invoice_rate: invRate, invoice_amount: lineAmount(ln),
        po_qty: null, po_rate: null,
        detail: "This line is not on the customer's purchase order.",
      };
    }
    invoicedKeys.add(key);

    const poQty = lineQty(po);
    const poRate = lineRate(po);
    const priorQty = billed.get(key) || 0;
    // The cumulative question, which is the only meaningful quantity check.
    const cumulative = invQty != null ? round2(priorQty + Number(invQty)) : priorQty;
    const overBy = (poQty != null && cumulative > Number(poQty)) ? round2(cumulative - Number(poQty)) : null;

    const price = comparePrice(invRate, poRate, tol);
    const desc = compareDescription(lineDesc(ln), lineDesc(po));

    // Worst-first, matching VERDICTS order.
    let verdict = "matched";
    let detail = null;
    if (overBy != null) {
      verdict = "qty_over_ordered";
      detail = `Invoicing ${invQty} brings the total billed to ${cumulative} against ${poQty} ordered — ${overBy} over.`;
      summary.qty_over_ordered += 1;
    } else if (price.mismatch) {
      verdict = "price_mismatch";
      detail = `Invoiced at ${invRate} against ${poRate} on the PO (${price.delta_pct > 0 ? "+" : ""}${price.delta_pct}%).`;
      summary.price_mismatch += 1;
    } else if (desc.mismatch) {
      verdict = "description_mismatch";
      detail = "The description differs from the PO line.";
      summary.description_mismatch += 1;
    } else {
      summary.matched += 1;
    }

    return {
      part_no: linePartNo(ln),
      verdict,
      // description_mismatch is worth showing and does not, on its own, stop a
      // goods receipt: buyers match on code and quantity.
      blocking: verdict !== "matched" && verdict !== "description_mismatch",
      invoice_qty: invQty, invoice_rate: invRate, invoice_amount: lineAmount(ln),
      po_qty: poQty, po_rate: poRate,
      previously_billed_qty: priorQty || null,
      cumulative_billed_qty: invQty != null ? cumulative : null,
      over_by: overBy,
      price_delta_pct: price.delta_pct,
      desc_agreement: desc.score,
      // A part appearing twice on the PO means "which line did you mean?" has
      // no answer. Reported, never guessed.
      ambiguous: ambiguous.has(key),
      detail,
    };
  });

  // The reverse walk: ordered, but not on this invoice. NOT a defect — it is
  // the normal state of a partial invoice — so it is reported separately from
  // `lines` and never counted as a discrepancy.
  const notInvoiced = [];
  for (const [key, po] of poByPart.entries()) {
    if (invoicedKeys.has(key)) continue;
    const poQty = lineQty(po);
    const priorQty = billed.get(key) || 0;
    const remaining = poQty != null ? round2(Number(poQty) - priorQty) : null;
    // Fully billed by earlier invoices: nothing outstanding, nothing to say.
    if (remaining != null && remaining <= 0) continue;
    notInvoiced.push({
      part_no: linePartNo(po), po_qty: poQty,
      previously_billed_qty: priorQty || null, remaining_qty: remaining,
      po_rate: lineRate(po), description: lineDesc(po),
    });
  }

  const blocking = lines.filter((l) => l.blocking);
  return {
    summary: { ...summary, blocking: blocking.length, not_invoiced: notInvoiced.length },
    lines,
    not_invoiced: notInvoiced,
    // The single question the caller usually wants answered.
    can_send: blocking.length === 0,
    price_tolerance_pct: tol,
    counted_invoice_statuses: COUNTED_INVOICE_STATUSES,
  };
};

// Totals agreement, which a buyer's AP clerk checks before any line detail.
export const compareTotals = (invoiceTotal, orderLines, opts = {}) => {
  const tol = opts.priceTolerancePct != null ? Number(opts.priceTolerancePct) : 0;
  const poTotal = (orderLines || []).reduce((s, ln) => {
    const a = lineAmount(ln);
    return a == null ? s : round2(s + a);
  }, 0);
  const inv = num(invoiceTotal);
  const cmp = comparePrice(inv, poTotal, tol);
  return { invoice_total: inv, po_line_total: poTotal, delta_pct: cmp.delta_pct, mismatch: cmp.mismatch };
};
