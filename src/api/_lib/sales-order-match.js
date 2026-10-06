// Which Anvil order does this sales order answer?
//
// The join that makes the Mode A/B comparison possible. A sales order is the
// ERP's reply to a customer purchase order, and it says which one: the buyer's
// reference is printed on the face of the document. `orders.po_number` holds
// the other side.
//
// The document's OWN number is not the join. A voucher number is the ERP's
// internal sequence — it means nothing to Anvil, nothing to the customer, and
// matching on it would match nothing at all. The extractor keeps the two in
// separate fields for exactly this reason.
//
// Pure. The caller does the queries.

// The comparison key.
//
// trim + uppercase, the convention payment-statement.js already uses to match
// a PO reference. Deliberately NOT stripping punctuation, unlike the part-number
// key in line-compare.js: "25PO0008243" and "25-PO-0008243" may well be
// different documents, and the cost of being wrong is not symmetric. A missed
// match asks a person to pick the order; a false match silently files a sales
// order against somebody else's, and every number compared afterwards is
// compared against the wrong thing.
export const poKey = (s) => String(s == null ? "" : s).trim().toUpperCase();

export const NO_MATCH = Object.freeze({
  NO_REFERENCE: "no_buyer_reference",
  NOT_FOUND: "no_order_with_that_reference",
  AMBIGUOUS: "several_orders_with_that_reference",
});

// Resolve an extracted sales order to exactly one order, or explain why not.
//
// `orders` is whatever the caller looked up — rows carrying at least
// { id, po_number }. Returns { matched, order, reason, candidates }.
//
// Ambiguity is REPORTED, never guessed. Two orders sharing a PO number is a
// real situation (a re-issued order, an amendment, a duplicate intake), and
// picking the newer one would be a coin flip dressed as a decision — the whole
// comparison downstream would then be measuring the wrong pair without saying
// so.
export const matchSalesOrderToOrders = (extract, orders) => {
  const ref = poKey(extract?.buyer_ref_order_no);
  if (!ref) {
    return {
      matched: false,
      reason: NO_MATCH.NO_REFERENCE,
      // Named so the caller can say WHICH field was missing rather than
      // "could not match", which sends an operator looking in the wrong place.
      detail: "The document does not carry a buyer's order reference, so there is nothing to match it to.",
      candidates: [],
    };
  }

  const hits = (orders || []).filter((o) => poKey(o?.po_number) === ref);
  if (!hits.length) {
    return {
      matched: false,
      reason: NO_MATCH.NOT_FOUND,
      reference: extract.buyer_ref_order_no,
      detail: `No order carries the purchase-order number "${extract.buyer_ref_order_no}".`,
      candidates: [],
    };
  }
  if (hits.length > 1) {
    return {
      matched: false,
      reason: NO_MATCH.AMBIGUOUS,
      reference: extract.buyer_ref_order_no,
      detail: `${hits.length} orders carry the purchase-order number "${extract.buyer_ref_order_no}". Pick the one this sales order answers.`,
      candidates: hits.map((o) => ({ id: o.id, po_number: o.po_number, created_at: o.created_at ?? null, status: o.status ?? null })),
    };
  }
  return { matched: true, order: hits[0], reference: extract.buyer_ref_order_no, candidates: [] };
};

// What the comparison will and will not be able to say about this document,
// decided BEFORE anything is stored.
//
// A sales order with no lines, or one the extractor classified as something
// else, can still be attached — the operator uploaded it for a reason and
// throwing it away helps nobody — but it cannot be compared, and saying so at
// attach time is the difference between a visible gap and a silent one.
export const comparability = (extract) => {
  const cls = extract?.classification || null;
  if (cls && cls !== "sales_order") {
    return { comparable: false, reason: "not_a_sales_order", detail: `The document read as "${cls}".` };
  }
  const lines = Array.isArray(extract?.lines) ? extract.lines : [];
  if (!lines.length) {
    return { comparable: false, reason: "no_lines", detail: "No line items could be read, so there is nothing to compare line by line." };
  }
  if (!poKey(extract?.buyer_ref_order_no)) {
    return { comparable: false, reason: NO_MATCH.NO_REFERENCE, detail: "No buyer's order reference, so it cannot be tied to an order." };
  }
  return { comparable: true, lines: lines.length };
};
