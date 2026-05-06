-- 061_customers_relational_fields.sql
--
-- Extend the customers table with the relational fields the so-intake
-- "new customer" dialog and the customer detail screen already
-- assume exist:
--   * currency           default sales currency for this customer
--   * payment_terms      free-text payment terms (Net 30, 50% advance, etc.)
--   * margin_floor_pct   per-customer margin floor (overrides tenant default)
--   * bill_to            multi-line bill-to address
--   * ship_to            multi-line ship-to address (defaults to bill_to)
--
-- All columns nullable + idempotent so re-running the migration is
-- safe on every environment.

alter table customers
  add column if not exists currency text,
  add column if not exists payment_terms text,
  add column if not exists margin_floor_pct numeric(5, 2),
  add column if not exists bill_to text,
  add column if not exists ship_to text;

-- Backfill: copy default_payment_terms into payment_terms so the
-- frontend's KV row stops rendering "—" for existing customers that
-- only have the legacy column.
update customers
set payment_terms = default_payment_terms
where payment_terms is null and default_payment_terms is not null;

-- Index nothing new; these columns are display-only and don't drive
-- any joins or filters in the existing query paths.
