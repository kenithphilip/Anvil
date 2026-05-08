-- 084_voice_consent_active_unique.sql
--
-- P2 from May 2026 critic: the original voice_consent unique
-- index is on (tenant_id, phone_number, scope, consented_at),
-- which is functionally "no enforcement at all" because
-- consented_at always differs row to row. Two active consent
-- records for the same number could co-exist; the matcher in
-- voice-compliance.js picked the most-recent one in app code,
-- but the DB never stopped a duplicate from landing.
--
-- Defence: drop the old constraint, add a partial unique on
-- (tenant_id, phone_number, scope) WHERE withdrawn_at IS NULL.
-- This guarantees at most one active consent per (tenant, phone,
-- scope), which is the application-level invariant.
-- Withdrawn rows are unconstrained so a customer can re-consent
-- after a withdrawal cycle.
--
-- Bug fix May 2026 (re-roll): the first version of this migration
-- failed in environments that already had duplicate active rows
-- (multiple consents granted for the same phone before the matcher
-- enforced the invariant in app code). The unique index can't be
-- created while duplicates exist, so we withdraw all but the most
-- recent active row per (tenant, phone, scope) before recreating
-- the index. Withdrawing older dupes is the safe semantic: it
-- preserves the audit row, the matcher never picked them anyway.
--
-- Idempotent.

update voice_consent
   set withdrawn_at = now(),
       notes = coalesce(notes || E'\n', '') || 'auto-withdrawn by migration 084 (deduplicate active rows)'
 where id in (
   select id
     from (
       select id,
              row_number() over (
                partition by tenant_id, phone_number, scope
                order by consented_at desc, id desc
              ) as rn
         from voice_consent
        where withdrawn_at is null
     ) ranked
    where rn > 1
 );

-- The original constraint may not exist if the schema was
-- created mid-migration; tolerate either case.
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'voice_consent_tenant_id_phone_number_scope_consented_at_key'
  ) then
    alter table voice_consent
      drop constraint voice_consent_tenant_id_phone_number_scope_consented_at_key;
  end if;
end $$;

drop index if exists voice_consent_active_uniq;

create unique index voice_consent_active_uniq
  on voice_consent (tenant_id, phone_number, scope)
  where withdrawn_at is null;
