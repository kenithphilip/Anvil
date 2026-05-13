-- 129_item_customer_parts_canonical_invariant.sql
--
-- Wave CM 2.1: canonical-bound mapping invariant.
--
-- The user requirement: many customer SAP numbers can map to
-- ONE Obara canonical part. The schema today already allows
-- many-to-one (composite PK on tenant + item + customer + part_no).
-- But it ALSO allows the same (tenant, customer, customer_part_number)
-- to map to TWO different items simultaneously. That's a bug.
--
-- This migration enforces "one active mapping per (customer,
-- customer_part_number)" via a partial unique index where
-- "active" is defined as `valid_to IS NULL`. The supersession
-- workflow is:
--
--   Before:  insert row { customer_part='X', item='A',  valid_to=NULL }
--   To replace A with B:
--     1. UPDATE the prior row SET valid_to = current_date.
--     2. INSERT a new row { customer_part='X', item='B', valid_to=NULL }.
--
-- The partial unique index allows step 2 because the prior row
-- no longer has valid_to=NULL after step 1. Superseded rows
-- (valid_to non-null) are preserved as audit trail and don't
-- block the new mapping.
--
-- Why NOT `valid_to IS NULL OR valid_to >= current_date`:
-- Postgres requires functions in index predicates to be
-- IMMUTABLE. `current_date` is STABLE, so the predicate is
-- rejected. The application could update valid_to to "today"
-- and have the row "expire" automatically, but the trade-off
-- of running an UPDATE in the supersession path is acceptable
-- for the safety of an enforceable invariant.
--
-- Idempotent.

drop index if exists item_customer_parts_one_canonical_per_part;

-- The partial unique index: one ACTIVE (valid_to IS NULL) row
-- per (tenant, customer, customer_part_number). Predicate is
-- pure-immutable so Postgres accepts it.
create unique index if not exists item_customer_parts_one_canonical_per_part
  on item_customer_parts (tenant_id, customer_id, customer_part_number)
  where valid_to is null;

comment on index item_customer_parts_one_canonical_per_part is
  'CM 2.1: enforces many-to-one. The same (tenant, customer, customer_part_number) can be active under at most one item_id at a time; superseded rows must carry a non-null valid_to.';

-- Audit-friendly: existing rows that already violate the new
-- invariant. We DO NOT auto-fix them (that's a data decision
-- the operator owns), but we surface them via a NOTICE.
do $$
declare
  conflict_count int;
begin
  select count(*) into conflict_count from (
    select tenant_id, customer_id, customer_part_number
      from item_customer_parts
      where valid_to is null
      group by tenant_id, customer_id, customer_part_number
      having count(distinct item_id) > 1
  ) conflicts;
  if conflict_count > 0 then
    raise notice 'CM 2.1: % active (customer, part) groups currently map to multiple item_id; the new unique index will reject future duplicates. Existing rows are preserved; operator must reconcile via the mapping workspace.', conflict_count;
  else
    raise notice 'CM 2.1: no active many-to-many violations found; invariant holds clean.';
  end if;
end $$;

-- Companion index for the supersession-history query.
create index if not exists item_customer_parts_superseded_idx
  on item_customer_parts (tenant_id, customer_id, customer_part_number, valid_to desc)
  where valid_to is not null;

-- Helper view: only-active mappings. Defined as valid_to IS NULL
-- for the same reason as the index predicate.
create or replace view item_customer_parts_active as
select *
  from item_customer_parts
 where valid_to is null;

comment on view item_customer_parts_active is
  'CM 2.1: rolling view of currently-active customer-part mappings (valid_to IS NULL). Resolver and UI prefer this over the underlying table so superseded rows are invisible by default.';
