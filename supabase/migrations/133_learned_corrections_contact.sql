-- 133_learned_corrections_contact.sql
--
-- Wave CM 3.3: contact-attributed mapping prior.
--
-- Some customers have multiple buyers with different
-- part-numbering conventions:
--   - Buyer A at Meridian uses GD544... codes.
--   - Buyer B at Meridian uses CH-DZ-... codes.
--
-- Today the active-learning prior (Wave 3.3 docai) collapses
-- every operator correction into one bucket per customer. When
-- a new PO arrives from Buyer A, the resolver gets equally-
-- weighted hints from both buyers, including the conflicting
-- ones, and the model has to disambiguate.
--
-- Solution: attribute every correction to the contact that sent
-- the source PO when known. The customer-hints priming then
-- preferentially surfaces corrections from the same contact.
--
-- Idempotent. Column add + index.

alter table learned_corrections
  add column if not exists customer_contact_id uuid
  references customer_contacts(id) on delete set null;

comment on column learned_corrections.customer_contact_id is
  'CM 3.3: contact attribution. When the inbound email resolved to a known contact, the correction inherits that contact_id; the priming engine then prefers corrections from the same contact on the next intake.';

create index if not exists learned_corrections_contact_idx
  on learned_corrections (tenant_id, customer_contact_id, created_at desc)
  where customer_contact_id is not null;
