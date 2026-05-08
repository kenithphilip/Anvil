-- 079_deploy_events.sql
--
-- Production change log table. Captures every production deploy
-- (Vercel deploy hook fires the new /api/deploys endpoint, which
-- writes one row per deploy event). The auditor reads this for
-- SOC 2 CC8.1 ("change management") evidence; the on-call uses it
-- to correlate post-deploy regressions with the deploy that
-- caused them.
--
-- Audit: DEFERRED_ROADMAP §4 code-side controls. Was the last
-- of three open SOC 2 deliverables (the access review and audit
-- log export endpoints already shipped); this lands the table
-- + endpoint so an auditor can pull the change log per quarter.
--
-- Idempotent.

create table if not exists deploy_events (
  id uuid primary key default uuid_generate_v4(),
  -- deploy_events are tenant-agnostic: a deploy is a code event,
  -- not a per-tenant event. We still partition reads by tenant in
  -- the endpoint so the auditor only sees the deploys their
  -- service plan covers, but the row itself is global.
  provider text not null check (provider in ('vercel', 'manual', 'other')),
  environment text not null check (environment in ('production', 'preview', 'development')),
  deployment_id text,                              -- vercel deployment id
  url text,                                        -- vercel deployment url
  commit_sha text,                                 -- git sha at deploy time
  commit_message text,                             -- first line of commit message
  branch text,                                     -- branch deployed
  state text not null check (state in ('queued', 'building', 'ready', 'error', 'cancelled')),
  ts timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb          -- raw provider payload for forensics
);

create index if not exists deploy_events_env_ts_idx
  on deploy_events (environment, ts desc);

create index if not exists deploy_events_branch_ts_idx
  on deploy_events (branch, ts desc)
  where branch is not null;

create index if not exists deploy_events_commit_idx
  on deploy_events (commit_sha)
  where commit_sha is not null;

-- RLS: the table is global (not per-tenant), but reads are still
-- restricted to authenticated callers via the endpoint's
-- requirePermission gate. Service role can write freely (the
-- /api/deploys writer uses serviceClient).
alter table deploy_events enable row level security;
drop policy if exists "deploy_events_authenticated_read" on deploy_events;
create policy "deploy_events_authenticated_read" on deploy_events
  for select using (auth.role() = 'authenticated');
