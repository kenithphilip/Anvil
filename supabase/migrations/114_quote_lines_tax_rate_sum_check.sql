-- 114_quote_lines_tax_rate_sum_check.sql
--
-- Phase 1 audit follow-up: a typo on any one of
-- cgst_pct + sgst_pct + igst_pct + utgst_pct + cess_pct
-- (e.g. entering "9" instead of "0.09") silently propagates
-- through quote_lines_with_totals to every PDF, every emitted
-- Tally voucher, and every converted order. Postgres has no
-- application-side aggregate guard.
--
-- This migration adds a per-row CHECK that the sum of all
-- five tax rates is at most 1.0 (100%). The columns store
-- fractions per the 108 comment ("0.0 to 1.0, e.g., 0.02 = 2%
-- off") so the bound is 1.0.
--
-- Idempotent: drops the old constraint if it exists before
-- adding the new one. Tolerates re-runs.

do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'quote_lines'
      and constraint_name = 'quote_lines_tax_rate_sum_check'
  ) then
    alter table quote_lines drop constraint quote_lines_tax_rate_sum_check;
  end if;
end $$;

alter table quote_lines
  add constraint quote_lines_tax_rate_sum_check
  check (
    coalesce(cgst_pct, 0)
    + coalesce(sgst_pct, 0)
    + coalesce(igst_pct, 0)
    + coalesce(utgst_pct, 0)
    + coalesce(cess_pct, 0)
    <= 1.0
  )
  not valid;

-- VALIDATE separately so existing rows that already exceed the
-- bound do not abort the migration. The constraint applies to
-- new writes immediately and to the historical rows on a
-- one-off `alter table ... validate constraint` once any out-
-- of-bound data has been cleaned up.
do $$ begin
  begin
    alter table quote_lines validate constraint quote_lines_tax_rate_sum_check;
  exception when check_violation then
    raise notice 'quote_lines tax-rate-sum CHECK has existing rows that exceed 1.0; left as NOT VALID. Clean up offending rows then run `alter table quote_lines validate constraint quote_lines_tax_rate_sum_check;`';
  end;
end $$;
