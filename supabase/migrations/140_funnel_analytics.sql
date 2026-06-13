-- 140_funnel_analytics.sql
-- Sales-ops funnel data layer (capture + aggregation).
--
-- A Sales Operations Head reviews funnel health: per-stage conversion,
-- velocity (time-in-stage), and aging. None of that was computable
-- because opportunity stage changes were only written to audit_events
-- (action='opp_stage_change') as before/after JSON blobs — not a
-- query-able stage-history table.
--
-- This migration adds the foundation, NOT the dashboard:
--   1. opportunity_stage_events  — one immutable row per stage
--      transition (the raw signal; cannot be backfilled once lost, so
--      capture starts now). Seeded from audit_events for existing opps.
--   2. analytics_funnel_daily    — daily per-stage snapshot the cron
--      materialises (entered/exited/count/value/age) so dashboard
--      reads are O(window) regardless of opportunity volume.
--
-- Both follow the existing analytics family (034_winloss_analytics):
-- service-role writes, tenant-scoped RLS select, idempotent upserts.

-- ---------------------------------------------------------------------------
-- 1. Raw capture: opportunity stage-transition events
-- ---------------------------------------------------------------------------
create table if not exists opportunity_stage_events (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  from_stage text,                              -- null on the creation event
  to_stage text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id),
  owner_id uuid,                                -- opp owner at the time
  amount_inr numeric(18, 2),                    -- opp value at the time
  probability numeric(5, 2),                    -- operator probability at the time
  days_in_from_stage numeric(10, 2),            -- dwell in from_stage (null if unknown)
  source text not null default 'live'           -- 'live' | 'backfill_audit'
    check (source in ('live', 'backfill_audit')),
  created_at timestamptz not null default now()
);

-- Per-opportunity timeline; per-stage slices; tenant-wide time windows.
create index if not exists opp_stage_events_opp_idx
  on opportunity_stage_events (tenant_id, opportunity_id, changed_at);
create index if not exists opp_stage_events_to_stage_idx
  on opportunity_stage_events (tenant_id, to_stage, changed_at desc);
create index if not exists opp_stage_events_window_idx
  on opportunity_stage_events (tenant_id, changed_at desc);

alter table opportunity_stage_events enable row level security;
drop policy if exists "opp_stage_events_select" on opportunity_stage_events;
create policy "opp_stage_events_select" on opportunity_stage_events
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- 2. Aggregation: daily per-stage funnel snapshot
-- ---------------------------------------------------------------------------
-- Grain: per (tenant, day, stage).
--   entered / exited        — transitions in/out of the stage that day
--                             (derived from immutable events; recompute-safe)
--   count_in_stage          — opps sitting in the stage at snapshot time
--   value_in_stage          — sum of amount_inr for those opps
--   weighted_value_in_stage — sum of amount_inr * probability
--   median_age_days/p90     — dwell of opps currently in the stage
--
-- entered/exited are written for every day in the window each run
-- (idempotent: events are immutable). The snapshot columns are written
-- only for the run's own day, so a daily cron accrues a real per-day
-- time series going forward without clobbering past snapshots.
create table if not exists analytics_funnel_daily (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  stage text not null,
  entered int not null default 0,
  exited int not null default 0,
  count_in_stage int,
  value_in_stage numeric(18, 2),
  weighted_value_in_stage numeric(18, 2),
  median_age_days numeric(10, 2),
  p90_age_days numeric(10, 2),
  updated_at timestamptz not null default now(),
  unique (tenant_id, day, stage)
);

create index if not exists analytics_funnel_daily_idx
  on analytics_funnel_daily (tenant_id, day desc);
create index if not exists analytics_funnel_daily_stage_idx
  on analytics_funnel_daily (tenant_id, stage, day desc);

alter table analytics_funnel_daily enable row level security;
drop policy if exists "analytics_funnel_daily_select" on analytics_funnel_daily;
create policy "analytics_funnel_daily_select" on analytics_funnel_daily
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- 3. Backfill stage events from the audit log
-- ---------------------------------------------------------------------------
-- We have historical opp_stage_change rows in audit_events with the
-- before/after stage in the payloads. Seed the events table so the
-- funnel has history from day one. Idempotent: only inserts rows that
-- don't already exist for the (opp, to_stage, changed_at) triple.
insert into opportunity_stage_events
  (tenant_id, opportunity_id, from_stage, to_stage, changed_at, changed_by, owner_id, amount_inr, probability, source)
select
  ae.tenant_id,
  ae.object_id::uuid,
  ae.before_payload->>'stage',
  ae.after_payload->>'stage',
  ae.created_at,
  ae.actor,
  (ae.after_payload->>'owner_id')::uuid,
  nullif(ae.after_payload->>'amount_inr', '')::numeric,
  nullif(ae.after_payload->>'probability', '')::numeric,
  'backfill_audit'
from audit_events ae
where ae.action = 'opp_stage_change'
  and ae.object_type = 'opportunity'
  and ae.object_id is not null
  and ae.after_payload->>'stage' is not null
  and exists (select 1 from opportunities o where o.id = ae.object_id::uuid)
  and not exists (
    select 1 from opportunity_stage_events e
    where e.opportunity_id = ae.object_id::uuid
      and e.to_stage = ae.after_payload->>'stage'
      and e.changed_at = ae.created_at
  );
