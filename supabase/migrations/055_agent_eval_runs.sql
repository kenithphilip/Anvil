-- 055_agent_eval_runs.sql
-- Phase 6 (C.3): Agent regression-eval results.
-- Each run replays a held-out slice of agent decisions against
-- operator-corrected ground truth and records a composite drift
-- score. Used by the Diagnostics tab to show model drift over time.
-- Idempotent.

create table if not exists agent_eval_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ran_at timestamptz not null default now(),
  cases_evaluated int not null default 0,
  avg_score numeric(6,4),
  summary jsonb not null default '{}'::jsonb,
  sample jsonb not null default '[]'::jsonb
);

create index if not exists agent_eval_runs_tenant_idx
  on agent_eval_runs (tenant_id, ran_at desc);

alter table agent_eval_runs enable row level security;
drop policy if exists "agent_eval_runs_owner" on agent_eval_runs;
create policy "agent_eval_runs_owner" on agent_eval_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
