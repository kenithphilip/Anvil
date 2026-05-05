-- 057_prospecting.sql
-- Phase 6 (C.6): Outbound prospecting agent.
--
-- Sequenced outbound emails through the existing SendGrid path,
-- gated behind a per-tenant approval flow. No mail goes out until
-- an admin clicks "approve" on a target. Suppression list is
-- per-tenant + global (unsubscribes never leak across tenants).
-- Idempotent.

create table if not exists prospecting_campaigns (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  template_subject text,
  template_body text,
  send_window_local_start time default '09:00',
  send_window_local_end   time default '17:00',
  daily_send_cap int default 100,
  status text not null default 'draft' check (status in ('draft','active','paused','archived')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prospecting_campaigns_tenant_idx
  on prospecting_campaigns (tenant_id, status);

alter table prospecting_campaigns enable row level security;
drop policy if exists "prospecting_campaigns_owner" on prospecting_campaigns;
create policy "prospecting_campaigns_owner" on prospecting_campaigns
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists prospecting_targets (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references prospecting_campaigns(id) on delete cascade,
  email text not null,
  display_name text,
  company text,
  title text,
  source text,
  score numeric(5,2),
  metadata jsonb default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','denied','sent','bounced','replied','unsubscribed')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  bounced_at timestamptz,
  replied_at timestamptz,
  unique (tenant_id, campaign_id, email)
);

create index if not exists prospecting_targets_pending_idx
  on prospecting_targets (tenant_id, status, score desc);

alter table prospecting_targets enable row level security;
drop policy if exists "prospecting_targets_owner" on prospecting_targets;
create policy "prospecting_targets_owner" on prospecting_targets
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Suppression list: global + per-tenant. A row in here means we
-- never email this address regardless of campaign.
create table if not exists prospecting_suppressions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  email text not null,
  reason text,
  added_at timestamptz not null default now(),
  -- NULL tenant_id = global suppression.
  unique (tenant_id, email)
);

create index if not exists prospecting_suppressions_email_idx
  on prospecting_suppressions (lower(email));

alter table prospecting_suppressions enable row level security;
drop policy if exists "prospecting_suppressions_select" on prospecting_suppressions;
create policy "prospecting_suppressions_select" on prospecting_suppressions
  for select using (
    tenant_id is null
    or tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
drop policy if exists "prospecting_suppressions_modify" on prospecting_suppressions;
create policy "prospecting_suppressions_modify" on prospecting_suppressions
  for all using (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  ) with check (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
