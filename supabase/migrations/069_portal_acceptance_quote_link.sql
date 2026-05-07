-- 069_portal_acceptance_quote_link.sql
--
-- Audit P6.6 prep. portal_quote_acceptances was order_id-keyed
-- (NOT NULL). The new quote-driven acceptance flow needs to
-- record acceptance against a quote that may not have an order
-- yet (the order is created on accept). Add a quote_id column
-- and relax the NOT NULL on order_id so an acceptance can land
-- as { quote_id, order_id (nullable until convert) } and later
-- backfill the order_id on the same row.

alter table portal_quote_acceptances
  alter column order_id drop not null,
  add column if not exists quote_id uuid references quotes(id) on delete set null;

create index if not exists portal_quote_acc_quote_idx
  on portal_quote_acceptances (tenant_id, quote_id)
  where quote_id is not null;
