-- 126_customer_master_golden_record.sql
--
-- Customer + Item Mapping overhaul, Wave CM 1.1 + 1.4.
--
-- CM 1.1: Golden record audit columns on `customers`.
-- CM 1.4: Sales-order-only enforcement on `item_customer_parts`.
--
-- Background. We're separating the customer master from contact
-- master (Salesforce-style) and tightening the many-to-one
-- canonical item mapping. The user constraint:
--
--   "Customer will use a SAP code. Unique to them. Obara only
--    maps it on the sales order. Not on purchase order Meant for
--    purchase or manufacturing... many part SAP numbers but
--    referred to a common Obara number based on customer master."
--
-- Two surfaces in this commit:
--
-- 1. customers golden-record fields. Even though we don't ship
--    the merge UI yet (that lands in CM 4.3), every new customer
--    row stamps the golden-record audit columns from day one so
--    the dedupe / merge cron (CM 4.2) has a clean schema to read.
--
--       is_golden          true on the canonical "winner" of a
--                          dedupe; false on rows that were
--                          merged into another (their FKs are
--                          re-pointed at duplicates_of).
--       golden_score       0..1 running score from the matcher,
--                          higher = more confident this is the
--                          authoritative row for the entity.
--       duplicates_of      back-pointer to the winning row when
--                          this row is a merged duplicate.
--       identity_hash      sha256 over (display_name normalised,
--                          gstin, country) - used as a blocking
--                          key by the Splink-style matcher.
--       contact_count      denormalised counter (touched by a
--                          trigger so the inbox UI doesn't
--                          re-count on every render).
--       last_active_at     last time an order, quote, contact,
--                          or extraction touched this row.
--       merge_blocked      operator soft-lock: when true the
--                          dedupe sweep skips this row even on
--                          high match probability. Defaults to
--                          false.
--
-- 2. item_customer_parts.applies_to text[]. Today the
--    resolver applies tier-1 (customer_part) on every dispatch
--    context. We need it to apply ONLY on sales orders. PO
--    intake (which doesn't call the resolver today) MUST stay
--    that way; if a future caller threads a PO line through the
--    same resolver, applies_to gates it. Default {'sales_order'}.
--    The mapper reads applies_to and skips rows whose array
--    does NOT contain the current context.
--
-- Idempotent. Every column add uses IF NOT EXISTS; the index
-- and triggers DROP-then-CREATE.

-- ============================================================
-- CM 1.1: golden record audit columns on customers
-- ============================================================

alter table customers
  add column if not exists is_golden       boolean not null default true,
  add column if not exists golden_score    numeric(5,4),
  add column if not exists duplicates_of   uuid references customers(id) on delete set null,
  add column if not exists identity_hash   text,
  add column if not exists contact_count   integer not null default 0,
  add column if not exists last_active_at  timestamptz,
  add column if not exists merge_blocked   boolean not null default false;

comment on column customers.is_golden is
  'CM 1.1: true on the canonical winner of dedupe; false when this row was merged into another.';
comment on column customers.golden_score is
  'CM 1.1: 0..1 confidence from the Splink-style matcher that this row is authoritative.';
comment on column customers.duplicates_of is
  'CM 1.1: back-pointer to the winning row when is_golden=false.';
comment on column customers.identity_hash is
  'CM 1.1: sha256 over normalised (display_name, gstin, country); blocking key for dedupe.';
comment on column customers.contact_count is
  'CM 1.1: denormalised contact_count, maintained by a trigger.';
comment on column customers.last_active_at is
  'CM 1.1: last time an order, quote, contact, or extraction touched this row.';
comment on column customers.merge_blocked is
  'CM 1.1: operator soft-lock; when true, the dedupe sweep skips this row.';

-- Sanity bound on golden_score.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'customers'
      and constraint_name = 'customers_golden_score_chk'
  ) then
    alter table customers drop constraint customers_golden_score_chk;
  end if;
end $$;
alter table customers
  add constraint customers_golden_score_chk
  check (golden_score is null or (golden_score >= 0 and golden_score <= 1));

-- A duplicate row CANNOT itself be golden, and a row cannot
-- duplicates_of itself.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'customers'
      and constraint_name = 'customers_duplicate_consistency_chk'
  ) then
    alter table customers drop constraint customers_duplicate_consistency_chk;
  end if;
end $$;
alter table customers
  add constraint customers_duplicate_consistency_chk
  check (
    (duplicates_of is null and is_golden = true)
    or (duplicates_of is not null and is_golden = false and duplicates_of <> id)
  );

-- Index for the dedupe blocking key.
create index if not exists customers_identity_hash_idx
  on customers (tenant_id, identity_hash)
  where identity_hash is not null and is_golden = true;

-- Index for "show me freshest active customers".
create index if not exists customers_last_active_at_idx
  on customers (tenant_id, last_active_at desc nulls last)
  where is_golden = true;

-- Index for "find non-golden rows that point at a specific winner"
-- (used by the merge UI to render the cluster).
create index if not exists customers_duplicates_of_idx
  on customers (tenant_id, duplicates_of)
  where duplicates_of is not null;

-- ============================================================
-- CM 1.4: sales-order-only enforcement on item_customer_parts
-- ============================================================

alter table item_customer_parts
  add column if not exists applies_to text[] not null default ARRAY['sales_order']::text[];

-- Soft-enum check on the array contents. Values are intentionally
-- open-ended (text[] with a CHECK) so we can extend without an
-- enum-migration. Today only 'sales_order' is meaningful; future
-- values may include 'quote' (Wave B's quote-driven learning
-- backwrite) or 'rfq' (lead-time quote intake).
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'item_customer_parts'
      and constraint_name = 'item_customer_parts_applies_to_chk'
  ) then
    alter table item_customer_parts drop constraint item_customer_parts_applies_to_chk;
  end if;
end $$;

alter table item_customer_parts
  add constraint item_customer_parts_applies_to_chk
  check (
    cardinality(applies_to) >= 1
    and applies_to <@ ARRAY['sales_order', 'quote', 'rfq', 'internal_so']::text[]
  );

comment on column item_customer_parts.applies_to is
  'CM 1.4: contexts this mapping applies to. Default {sales_order}. Resolver filters on context; PO / manufacturing paths skip mappings whose applies_to does not include them.';

-- Backfill any pre-migration rows. The default fires on INSERT
-- but existing rows pre-add carry NULL until we touch them.
-- IF NOT EXISTS on the column means existing rows from a prior
-- migration run would already have the default; the UPDATE here
-- is a safety net for the legacy case where the column existed
-- without a default.
update item_customer_parts
   set applies_to = ARRAY['sales_order']::text[]
 where applies_to is null;

-- Partial GIN index so the resolver's `applies_to @> '{sales_order}'`
-- filter scans the index instead of every row.
create index if not exists item_customer_parts_applies_to_idx
  on item_customer_parts using gin (applies_to);

-- ============================================================
-- Trigger to keep customers.contact_count in sync
-- ============================================================

create or replace function customers_recount_contacts() returns trigger
language plpgsql as $$
declare
  target uuid;
begin
  if (TG_OP = 'DELETE') then
    target := OLD.customer_id;
  else
    target := NEW.customer_id;
  end if;
  if target is null then return null; end if;
  update customers
     set contact_count = (
       select count(*)::int
         from customer_contacts c
        where c.customer_id = target
     ),
     last_active_at = greatest(coalesce(last_active_at, '-infinity'::timestamptz), now())
   where id = target;
  return null;
end;
$$;

drop trigger if exists customers_recount_contacts_trg on customer_contacts;
create trigger customers_recount_contacts_trg
  after insert or update or delete on customer_contacts
  for each row
  execute function customers_recount_contacts();

-- ============================================================
-- One-shot backfill of contact_count + last_active_at for
-- existing rows. Idempotent: re-running just refreshes values.
-- ============================================================

update customers c
   set contact_count = sub.cnt
  from (
    select customer_id, count(*)::int as cnt
      from customer_contacts
      group by customer_id
  ) sub
 where c.id = sub.customer_id;
