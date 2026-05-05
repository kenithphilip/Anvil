-- 053_soc2_controls.sql
-- Phase 6 (C.1): SOC 2 Type I code-side controls.
--
-- Three artefacts the auditor will sample:
--   1. access_reviews: monthly snapshot of every member's role per
--      tenant, signed by the admin who reviewed the report.
--   2. deploys: log of every Vercel deploy (commit sha, env, who).
--   3. audit_export_runs: who exported what time-window, used for
--      access-control evidence on the audit trail itself.
-- Idempotent.

create table if not exists access_reviews (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz not null default now(),
  -- Snapshot of member -> role at the moment of the review.
  -- Stored as JSONB so we don't need a separate row per member.
  members jsonb not null default '[]'::jsonb,
  acknowledgement_text text,
  signed_hash text,
  notes text
);

create index if not exists access_reviews_tenant_idx
  on access_reviews (tenant_id, reviewed_at desc);

alter table access_reviews enable row level security;
drop policy if exists "access_reviews_owner" on access_reviews;
create policy "access_reviews_owner" on access_reviews
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists deploys (
  id uuid primary key default uuid_generate_v4(),
  -- Deploys are global (not tenant-scoped); they describe the
  -- platform itself, not customer data.
  commit_sha text not null,
  environment text not null check (environment in ('preview','production')),
  deployed_at timestamptz not null default now(),
  deployed_by text,
  branch text,
  url text,
  meta jsonb default '{}'::jsonb,
  unique (commit_sha, environment)
);

create index if not exists deploys_recent_idx on deploys (deployed_at desc);

-- Deploys are read-only for everyone; only the deploy-hook write
-- path (using service role) inserts. RLS off so SOC 2 reviewers
-- can read across tenants without role-bouncing.

create table if not exists audit_export_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  exported_by uuid references auth.users(id),
  exported_at timestamptz not null default now(),
  from_ts timestamptz,
  to_ts timestamptz,
  type_filters text[],
  rows_exported int default 0,
  signed_hash text
);

create index if not exists audit_export_runs_tenant_idx
  on audit_export_runs (tenant_id, exported_at desc);

alter table audit_export_runs enable row level security;
drop policy if exists "audit_export_runs_owner" on audit_export_runs;
create policy "audit_export_runs_owner" on audit_export_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
