-- 129_item_customer_parts_canonical_invariant.sql
--
-- Wave CM 2.1: canonical-bound mapping invariant.
--
-- The user constraint:
--
--   "many part SAP numbers but referred to a common Obara number
--    based on customer master."
--
-- That's the many-to-one shape: many (customer, customer_part_number)
-- rows can point at ONE item_master row. The schema today already
-- allows that because the PK is (tenant, item, customer, part_no).
-- BUT the reverse is also currently permitted: the same
-- (tenant, customer, customer_part_number) pair can be entered
-- twice with two different item_id values, breaking the
-- "one canonical mapping per buyer code" invariant.
--
-- Example of the bug today:
--   row 1: customer Hyundai, part GD544...0008 -> item THB-L1-GA
--   row 2: customer Hyundai, part GD544...0008 -> item THB-L1-PH
-- The resolver picks whichever is read first; the operator gets
-- a non-deterministic result.
--
-- This migration adds a partial unique index that enforces the
-- correct direction:
--
--   For each (tenant, customer, customer_part_number), at most
--   ONE ACTIVE row can exist. Activity is defined as:
--     valid_to IS NULL OR valid_to >= today.
--
-- Inactive rows (operator soft-deleted via valid_to in the past)
-- are not constrained, so the audit trail of prior mappings is
-- preserved.
--
-- Idempotent.

-- Drop any prior partial index by this name (in case of re-run
-- with a different predicate).
drop index if exists item_customer_parts_one_canonical_per_part;

-- The partial unique index enforces ONE active item_id per
-- (tenant, customer, customer_part_number).
create unique index if not exists item_customer_parts_one_canonical_per_part
  on item_customer_parts (tenant_id, customer_id, customer_part_number)
  where valid_to is null or valid_to >= current_date;

comment on index item_customer_parts_one_canonical_per_part is
  'CM 2.1: enforces many-to-one. The same (tenant, customer, customer_part_number) can be active under at most one item_id at a time; superseded rows must carry valid_to < today.';

-- Audit-friendly: existing rows that already violate the new
-- invariant. We DO NOT auto-fix them (that's a data decision
-- the operator owns), but we surface them via a verification
-- query the operator can run after the migration.
do $$
declare
  conflict_count int;
begin
  select count(*) into conflict_count from (
    select tenant_id, customer_id, customer_part_number
      from item_customer_parts
      where valid_to is null or valid_to >= current_date
      group by tenant_id, customer_id, customer_part_number
      having count(distinct item_id) > 1
  ) conflicts;
  if conflict_count > 0 then
    raise notice 'CM 2.1: % active (customer, part) groups currently map to multiple item_id; the new unique index will reject future duplicates. Existing rows are preserved; operator must reconcile via the mapping workspace.', conflict_count;
  else
    raise notice 'CM 2.1: no active many-to-many violations found; invariant holds clean.';
  end if;
end $$;

-- Companion index for the supersession workflow: "show me every
-- mapping that has been superseded (valid_to < today) for this
-- customer + part".
create index if not exists item_customer_parts_superseded_idx
  on item_customer_parts (tenant_id, customer_id, customer_part_number, valid_to desc)
  where valid_to is not null and valid_to < current_date;

-- Helper view: only-active mappings. The resolver and the
-- admin UI can SELECT from this view instead of remembering the
-- valid_to filter. Materialised? No: trivial filter, fast index
-- scan; refresh latency would defeat the audit-trail purpose.
create or replace view item_customer_parts_active as
select *
  from item_customer_parts
 where (valid_to is null or valid_to >= current_date);

comment on view item_customer_parts_active is
  'CM 2.1: rolling view of currently-active customer-part mappings. Resolver and UI prefer this over the underlying table so superseded rows are invisible by default.';
