-- 222_sales_order_document_role.sql
--
-- order_documents.role gains 'sales_order'.
--
-- A sales order is the ERP's reply to a customer purchase order, and Mode A/B
-- compares it against both the PO and Anvil's own proposal. Linking it to the
-- order it answers is what makes that comparison findable later; the extract
-- itself already lives on the extraction_run, keyed by source_id = document_id,
-- so no new table is needed to hold it.
--
-- The role CHECK has not moved since migration 001. Extending it is additive:
-- every existing role stays permitted and no row changes.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'order_documents'::regclass
      and conname = 'order_documents_role_check'
  ) then
    alter table order_documents drop constraint order_documents_role_check;
  end if;
end $$;

alter table order_documents
  add constraint order_documents_role_check
  check (role in (
    'purchase_order', 'quote', 'price_composition', 'attachment', 'supplier_ack',
    -- New here.
    'sales_order'
  ));

comment on column order_documents.role is
  'What the document is TO this order. sales_order = the order acknowledgement the customer''s ERP produced in reply, attached for the Mode A/B three-way comparison against the PO and Anvil''s own proposal.';
