-- 161_icp_profiles.sql
--
-- Customer ICP (Ideal Customer Profile) framework (design:
-- docs/ICP_FRAMEWORK_DESIGN.md). A tenant defines one or more named ICP
-- rubrics (a hard gate + weighted rules + tier cutoffs) over a GENERIC
-- attribute map, so any company scores its own ICP with no schema change --
-- rules reference field_keys from customer_registration_fields + core customer
-- columns + hierarchy. The pure scorer is src/api/_lib/icp.js. Per-customer
-- fit is cached on `customers` (icp_score/tier/signals), computed on
-- registration save + a cron refresh + on demand, alongside ai_health_*.

create table if not exists icp_profiles (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null default 'Default ICP',
  active boolean not null default true,
  gate jsonb not null default '[]'::jsonb,   -- hard qualifiers (fail -> tier "Out")
  rules jsonb not null default '[]'::jsonb,   -- [{ attribute_key, op, value?, weight, label? }]
  tiers jsonb not null default '[]'::jsonb,   -- [{ min, tier }]
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists icp_profiles_tenant_active_idx on icp_profiles (tenant_id, active);

alter table icp_profiles enable row level security;
drop policy if exists "icp_profiles_all" on icp_profiles;
create policy "icp_profiles_all" on icp_profiles
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Per-customer ICP fit (distinct axis from ai_health_*). Idempotent adds.
alter table customers add column if not exists icp_score int;
alter table customers add column if not exists icp_tier text;
alter table customers add column if not exists icp_profile_id uuid references icp_profiles(id) on delete set null;
alter table customers add column if not exists icp_signals jsonb;
alter table customers add column if not exists icp_scored_at timestamptz;
