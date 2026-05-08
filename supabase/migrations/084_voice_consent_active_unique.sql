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
-- Idempotent.

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
