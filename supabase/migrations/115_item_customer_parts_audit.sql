-- 115_item_customer_parts_audit.sql
--
-- Audit columns on item_customer_parts so the learning loop is
-- traceable: who confirmed each mapping, how, when, and at what
-- confidence. Required by the six-piece item-mapping automation
-- (Layers A/B/C/D + drawer "Used by these customers" tab + the
-- shared admin upsert helper).
--
-- Schema before this migration (from 105_item_master_extension.sql
-- lines 345-358):
--   tenant_id, item_id, customer_id, customer_part_number,
--   customer_part_description, customer_project, valid_from,
--   valid_to, is_primary, created_at, updated_at.
--
-- New columns:
--   created_by      uuid    auth.users(id) of the operator who
--                           created the row. Existing rows
--                           (legacy / migration backfill) stay
--                           null and are tagged via created_via.
--   created_via     text    How the row landed:
--                             manual          = operator picked
--                                               canonical on
--                                               recon table OR
--                                               via admin drawer
--                             quote_sent      = Layer B write on
--                                               quote SENT
--                             quote_accepted  = reserved for a
--                                               future ACCEPTED
--                                               write-back
--                             bulk_import     = Layer D CSV/XLSX
--                             llm_suggest     = Layer C, operator
--                                               accepted an AI
--                                               suggestion
--                             cross_customer  = reserved for a
--                                               future "another
--                                               customer already
--                                               mapped this code"
--                                               heuristic
--                             legacy          = explicitly tagged
--                                               historical row
--   confidence_pct  numeric(5,2)  0-100. manual=100, quote_sent=95,
--                                 llm_suggest=<model score>.
--   confirmed_at    timestamptz   When the last human confirmed
--                                 the row (manual / llm_suggest
--                                 accept / bulk_import). Null for
--                                 unconfirmed (e.g. legacy back-
--                                 fill).
--   confirmed_by    uuid    auth.users(id) of last confirmer.
--
-- Idempotent: every column add uses IF NOT EXISTS, the CHECK
-- constraint is dropped before recreate, the index uses IF NOT
-- EXISTS. Safe to re-run.

alter table item_customer_parts
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists created_via text,
  add column if not exists confidence_pct numeric(5,2),
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references auth.users(id) on delete set null;

-- Soft-enum guardrail. Free-form text + CHECK so we can add new
-- values later without an enum migration. NULL allowed so legacy
-- rows pass; the application stamps a non-null value on every new
-- write.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'item_customer_parts'
      and constraint_name = 'item_customer_parts_created_via_chk'
  ) then
    alter table item_customer_parts drop constraint item_customer_parts_created_via_chk;
  end if;
end $$;

alter table item_customer_parts
  add constraint item_customer_parts_created_via_chk
  check (
    created_via is null or created_via in (
      'manual',
      'quote_sent',
      'quote_accepted',
      'bulk_import',
      'llm_suggest',
      'cross_customer',
      'legacy'
    )
  );

-- Confidence sanity bound.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'item_customer_parts'
      and constraint_name = 'item_customer_parts_confidence_pct_chk'
  ) then
    alter table item_customer_parts drop constraint item_customer_parts_confidence_pct_chk;
  end if;
end $$;

alter table item_customer_parts
  add constraint item_customer_parts_confidence_pct_chk
  check (confidence_pct is null or (confidence_pct >= 0 and confidence_pct <= 100));

-- Telemetry index for "show me everything Layer C surfaced last
-- week" and the drawer's `order by confirmed_at desc` sort.
create index if not exists item_customer_parts_by_created_via
  on item_customer_parts (tenant_id, created_via);

create index if not exists item_customer_parts_by_confirmed_at
  on item_customer_parts (tenant_id, confirmed_at desc nulls last);

comment on column item_customer_parts.created_by is 'auth.users(id) who created the row';
comment on column item_customer_parts.created_via is 'manual|quote_sent|quote_accepted|bulk_import|llm_suggest|cross_customer|legacy';
comment on column item_customer_parts.confidence_pct is '0-100: manual=100, quote_sent=95, llm_suggest=<model score>';
comment on column item_customer_parts.confirmed_at is 'last time a human confirmed this mapping';
comment on column item_customer_parts.confirmed_by is 'auth.users(id) of the last confirmer';
