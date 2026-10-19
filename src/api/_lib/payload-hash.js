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
//
// The customer is the order's customer_id as well as the buyer block the PO
// printed. The id is who the SO is raised for (its bill-to, its tax state, its
// ledger), and since plan PR 7 it can be changed before approval. Without it a
// customer change left the hash where it was, so an approver's stale view
// passed the hash check, and the reconcile's once-per-hash guard skipped the
// new customer's quotes.

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
      id: order?.customer_id ?? null,
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

// Public: the hash to store after a write that turns `before` into `after`,
// or null to leave the stored one as it is. The writers that change an
// order's lines or customer call it: the PATCH, the quote reconcile and the
// background extraction writeback. The ERP push and sync handlers write only
// their own keys under result, never the lines.
//
// One writer is a deliberate exception. A customer merge
// (_lib/customer-merge.js) re-points orders.customer_id from a duplicate
// record to the surviving one. It is the same buyer, so the stored hash
// stays, and the approver's hash still approves. The next content write moves
// it, and the reconcile's once-per-hash guard lets the survivor's quotes in.
//
// It moves when what the approver approves moved, whoever wrote it and
// whether or not a quote priced the order. It used to stop moving once an
// order had a quote_id, and the reconcile links a quote to every scanned PO
// it matches, so an edit after the approver loaded such an order was still
// approved.
//
// It does not move for a write that changes none of that: a re-save of the
// same lines, a reconcile that filled nothing, a status change. So an
// approver's hash stays good while the order is what they saw, and an order
// converted from a quote keeps the quote's hash (quotes/convert.js) until its
// content changes. An order with no stored hash gets one.
export const payloadHashAfterWrite = (before, after) => {
  const next = computeOrderPayloadHash(after);
  if (!next) return null;
  if (before?.payload_hash && computeOrderPayloadHash(before) === next) return null;
  return next;
};

// Public: the approval columns to clear after a server write that changed
// what an approved order's approver approved, or null. The PATCH clears them
// for an edit (editKeys in orders/[id].js). The quote reconcile and the
// background writeback can change an APPROVED order's lines too: the manual
// reconcile runs at any status, and the writeback lands whenever its job
// finishes. Without this the approval stayed on lines its approver never saw,
// and the Tally push, which checks only that an approval exists, pushed them.
// A write that changes nothing keeps the approval.
export const approvalClearedByContentChange = (before, after) => {
  if (!before?.approval) return null;
  if (computeOrderPayloadHash(before) === computeOrderPayloadHash(after)) return null;
  return { approval: null, approval_expires_at: null, approval_actions: [] };
};
