-- 214_invoices_customer_po_number.sql
--
-- Put the BUYER's purchase-order number on our outbound invoice.
--
-- WHY. A large buyer books an incoming invoice against the purchase order it
-- was raised for. Their goods-receipt / three-way match keys on that PO
-- reference, and an invoice arriving without it is rejected clerically —
-- before anyone even looks at the lines or the amounts. No GRN, no payment.
--
-- WHAT WAS HAPPENING. src/api/invoices/index.js SELECTed orders.po_number and
-- then discarded it: invoiceFromOrder (src/api/_lib/invoicing.js) never read
-- the field, `invoices` had no column to hold it, and the invoice PDF printed
-- no buyer reference of any kind. The only place the PO number survived was
-- the GSTN e-invoice payload (src/api/einvoice/index.js), which uses it as the
-- document number — so the tax filing carried the reference and the document
-- the customer actually receives did not.
--
-- WHY A COLUMN RATHER THAN A JOIN. invoices.order_id already reaches
-- orders.po_number, but an invoice is a legal document: it must state what was
-- true when it was ISSUED. Re-deriving the reference at render time means a
-- later correction to the order silently changes an invoice already sent and
-- filed. Snapshot it, like invoice_number and the totals beside it.
--
-- Nullable on purpose. Existing invoices are not backfilled: we cannot know
-- whether an old invoice was issued against the PO its order now names, and
-- inventing that reference is worse than leaving it blank. Backfill is a
-- deliberate, separately-reviewed act if it is ever wanted.

alter table invoices
  add column if not exists customer_po_number text;

comment on column invoices.customer_po_number is
  'The BUYER''s purchase-order number, snapshotted from orders.po_number when '
  'the invoice was created. Printed on the invoice so the customer can book it '
  'against their PO and complete goods receipt. Null for invoices created '
  'before migration 214, and for invoices with no originating PO.';

-- Finding an invoice by the customer's PO reference is exactly what happens
-- when they call to ask why a receipt has not been booked.
create index if not exists invoices_customer_po_idx
  on invoices (tenant_id, customer_po_number)
  where customer_po_number is not null;
