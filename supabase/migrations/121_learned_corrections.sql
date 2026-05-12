-- 121_learned_corrections.sql
--
-- Wave 3.3 / Improvement #8: active-learning feedback loop.
--
-- Today the docai pipeline has two persistence layers for
-- operator corrections:
--   1. customer_field_overrides (loaded by overrides.js): applied
--      to every run via apply_path > replacement.
--   2. customer_format_templates / global templates: anchor +
--      regex extraction rules.
--
-- Neither captures the per-extraction-run granularity: when the
-- operator edits "the gemini extractor returned unit_price=100
-- but I corrected it to 110 because the line was on page 4 of
-- the SAP PO that the model misread". We have no record that
-- the correction happened, no signal to bias the model next
-- time, no signal to drop confidence on similar patterns.
--
-- learned_corrections solves that. Every operator edit on the
-- recon table writes ONE row:
--
--   tenant_id, customer_id?, extraction_run_id, field_path,
--   model_value, operator_value, diff_kind, severity,
--   adapter_used, selected_model, confidence_at_extraction,
--   created_at, created_by
--
-- The downstream signal:
--   - The per-customer hint priming (Wave 1.5) reads
--     learned_corrections to inject "this customer's previous
--     POs had X corrected to Y" into the system prompt.
--   - The eval suite reads learned_corrections to score the
--     extractor against the operator-true value over time.
--   - The diagnostics tab plots correction rate per adapter
--     per field, so an operator can see "claude misreads HSN
--     6% of the time on Hyundai POs".
--   - When 3+ corrections of the same diff_kind land on the
--     same (customer, field_path) within 30 days, a
--     customer_field_overrides row is auto-suggested.
--
-- Idempotent. The triple (tenant_id, extraction_run_id,
-- field_path) is the PK so re-editing the same field on the
-- same run replaces (UPSERT) the prior row.

create table if not exists learned_corrections (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references tenants(id) on delete cascade,
  customer_id                 uuid references customers(id) on delete set null,
  extraction_run_id           uuid references extraction_runs(id) on delete cascade,
  field_path                  text not null,            -- e.g. "customer.gstin", "lines[3].unitPrice"
  model_value                 jsonb,                    -- whatever the extractor produced
  operator_value              jsonb,                    -- whatever the operator typed
  diff_kind                   text not null,            -- 'replace', 'add', 'remove'
  severity                    text not null default 'medium',  -- 'low' | 'medium' | 'high'
  adapter_used                text,                     -- claude / gemini / reducto / voter / ...
  selected_model              text,                     -- the deterministic-selector pick
  confidence_at_extraction    numeric(5,4),             -- what the model thought before the operator fixed it
  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users(id) on delete set null,
  constraint learned_corrections_diff_kind_chk
    check (diff_kind in ('replace', 'add', 'remove')),
  constraint learned_corrections_severity_chk
    check (severity in ('low', 'medium', 'high'))
);

-- Composite uniqueness: one row per (tenant, run, field_path).
-- Re-editing the same field UPSERTs (replaces) the prior row.
create unique index if not exists learned_corrections_pk_compound
  on learned_corrections (tenant_id, extraction_run_id, field_path);

-- Query indices.
create index if not exists learned_corrections_by_customer
  on learned_corrections (tenant_id, customer_id, created_at desc);

create index if not exists learned_corrections_by_field
  on learned_corrections (tenant_id, field_path, created_at desc);

create index if not exists learned_corrections_by_adapter
  on learned_corrections (tenant_id, adapter_used, created_at desc);

alter table learned_corrections enable row level security;

-- Same-tenant policy: every operator on the tenant can read +
-- write rows scoped to their tenant. Service role (cron) bypasses
-- RLS for the per-customer learning aggregation.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'learned_corrections'
      and policyname = 'learned_corrections_tenant_read'
  ) then
    create policy learned_corrections_tenant_read
      on learned_corrections for select
      to authenticated
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'learned_corrections'
      and policyname = 'learned_corrections_tenant_insert'
  ) then
    create policy learned_corrections_tenant_insert
      on learned_corrections for insert
      to authenticated
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'learned_corrections'
      and policyname = 'learned_corrections_tenant_update'
  ) then
    create policy learned_corrections_tenant_update
      on learned_corrections for update
      to authenticated
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
end $$;

comment on table learned_corrections is
  'Wave 3.3: every operator edit on a docai-extracted field. Drives the active-learning feedback loop and per-customer hint priming.';
