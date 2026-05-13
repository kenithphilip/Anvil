-- 132_item_customer_parts_auto_consensus.sql
--
-- Wave CM 3.1: allow 'auto_consensus' as a created_via value on
-- item_customer_parts so the N-of-M auto-promote cron can stamp
-- promoted rows.
--
-- Migration 115 added the soft-enum check; we rebuild it to
-- include the new value. The full enum becomes:
--   manual / quote_sent / quote_accepted / bulk_import /
--   llm_suggest / cross_customer / legacy / auto_consensus.
--
-- Idempotent. Drop-then-recreate is safe even on a fresh DB
-- because the DO block guards on existence.

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
      'legacy',
      'auto_consensus'
    )
  );

comment on column item_customer_parts.created_via is
  'manual|quote_sent|quote_accepted|bulk_import|llm_suggest|cross_customer|legacy|auto_consensus';
