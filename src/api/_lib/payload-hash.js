// Canonical payload hash for an order.
//
// WHY THIS EXISTS: the approve handler refuses without
// `body.approval.payloadHash` (orders/[id].js), and the workspace sources that
// from `orders.payload_hash`, hard-refusing when it is null. But
// `orders.payload_hash` was only ever written on the QUOTE path
// (quotes/send.js computes it, quotes/convert.js + portal/accept_quote.js
// carry it forward). On the scanned-PO path `orders/index.js` stores
// `body.payload_hash || null` and the intake never sends one, and
// send-for-review only flipped the status.
//
// Net effect: a scanned PO could never be approved, so it could never be
// pushed to Tally. The whole ERP leg was reachable only from quote->order
// conversion. This closes that gap.
//
// The hash is over the COMMERCIALLY MEANINGFUL payload — what an approver is
// actually signing off — so it changes when the lines, prices, quantities or
// customer identity change, and is stable across unrelated edits (status
// flips, notes, timestamps). Line ORDER is significant: re-ordering lines is a
// real change to the document.

import crypto from "node:crypto";

// Pull the fields that define a line commercially. Anything not listed here
// (mapping metadata, evidence, provenance) deliberately does NOT affect the
// hash — an operator mapping a line to the item master is not a change to what
// the customer ordered.
const canonicalLine = (l) => ({
  partNumber: l?.partNumber ?? null,
  customerItemCode: l?.customerItemCode ?? null,
  description: l?.description ?? null,
  quantity: l?.quantity ?? null,
  unitPrice: l?.unitPrice ?? null,
  uom: l?.uom ?? null,
  hsn: l?.hsn ?? null,
  gst_pct: l?.gst_pct ?? null,
  amount: l?.amount ?? null,
});

// Public: the canonical object that gets hashed. Exported so a future
// verify-at-approve step (and its tests) can diff two payloads and show the
// operator WHAT changed, rather than just "hash mismatch".
export const canonicalOrderPayload = (order) => {
  const so = order?.result?.salesOrder || {};
  const cust = so.customer || {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems : [];
  return {
    po_number: cust.po_number ?? order?.po_number ?? null,
    customer: {
      name: cust.name ?? null,
      gstin: cust.gstin ?? null,
      currency: cust.currency ?? null,
    },
    lines: lines.map(canonicalLine),
    totals: {
      grand_total: so.grandTotal ?? so.grand_total ?? null,
      sub_total: so.subTotal ?? so.sub_total ?? null,
    },
  };
};

// Public: sha256 of the canonical payload. Returns null when there is nothing
// commercially meaningful to hash (no lines AND no PO number) — hashing an
// empty shell would produce a constant that every empty order shares, which is
// worse than null because it looks like a real approval token.
export const computeOrderPayloadHash = (order) => {
  const payload = canonicalOrderPayload(order);
  if (!payload.lines.length && !payload.po_number) return null;
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};
