-- 110_tally_voucher_type_per_company.sql
--
-- Phase 1 F1 fix from docs/audits/2026_05_11_product_deep_dive
-- and AUDIT_2026_05_12_fresh_round3: the Tally voucher emit was
-- hardcoded to VCHTYPE="Sales Order", which Tally treats as a
-- non-accounting tracker voucher. It does not post to the GL,
-- does not book GST output, and does not feed the input-tax-credit
-- chain on the buyer side.
--
-- The right voucher type depends on how the tenant uses Tally:
--
--   - "Sales": the accounting voucher; books revenue + GST output
--     at the moment Anvil pushes the SO. Correct for tenants who
--     do not separately invoice in Tally.
--
--   - "SalesOrder": the tracker voucher; useful only if a later
--     "Sales" voucher will book the sale at delivery.
--
-- Default to "Sales" per the audit recommendation. Multi-company
-- tenants override per company.

alter table tally_companies
  add column if not exists default_sales_voucher_type text default 'Sales';

do $$ begin
  if exists (select 1 from information_schema.table_constraints
             where table_name = 'tally_companies'
               and constraint_name = 'tally_companies_default_sales_voucher_type_check') then
    alter table tally_companies
      drop constraint tally_companies_default_sales_voucher_type_check;
  end if;
end $$;

alter table tally_companies
  add constraint tally_companies_default_sales_voucher_type_check
  check (default_sales_voucher_type in ('Sales', 'SalesOrder'));

comment on column tally_companies.default_sales_voucher_type is
  'Tally voucher type used when emitting a sales-order voucher. Sales: accounting voucher that books revenue + GST output (default). SalesOrder: non-accounting tracker; use only when the sale is booked separately at delivery via a Sales voucher.';

-- Backfill: existing rows that pre-date this column get the safe
-- default. The column has a default but a no-op upgrade on a row
-- that already exists will not populate it; this update closes that.
update tally_companies
   set default_sales_voucher_type = 'Sales'
 where default_sales_voucher_type is null;
