-- 011_agent_goals.sql
-- Autonomous follow-up agent v1.
--
-- A "goal" is a long-running, autonomous task the platform agrees to
-- pursue on the operator's behalf. The cron runner at
-- /api/agents/run walks every active goal, decides the next action,
-- executes it through the existing communications pipeline, and
-- updates the row.
--
-- Three initial goal types (kept open via text + check rather than
-- enum so adding a fourth doesn't require a migration):
--   quote_accept_within_14d  Drive a draft/sent quote to acceptance.
--                            Target row: orders.id where status is
--                            QUOTE_DRAFT / QUOTE_SENT.
--   ar_collect_by_due_plus_7 Drive an unpaid invoice to collected
--                            within 7 days of its due_date.
--                            Target row: einvoices.id (or future
--                            invoices.id when non-India ships).
--   missing_doc_followup     Drive an order with missing required
--                            documents to complete intake.
--                            Target row: orders.id.
--
-- The runner stores a per-step "thought + action + result" in
-- agent_steps so the operator can audit what the agent did at each
-- tick. Idempotent.

create table if not exists agent_goals (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,

  goal_type text not null check (goal_type in (
    'quote_accept_within_14d',
    'ar_collect_by_due_plus_7',
    'missing_doc_followup'
  )),

  -- The thing the goal is acting on. We keep it as (object_type, object_id)
  -- instead of a hard FK so a single goal table can target orders, invoices,
  -- or future entity types without schema gymnastics.
  object_type text not null,                -- 'order' | 'einvoice' | future
  object_id uuid not null,

  -- Lifecycle. We start in 'active', flip to 'paused' if the operator
  -- snoozes, 'completed' on success, 'cancelled' on giving up, 'failed'
  -- if the runner repeatedly hits errors.
  status text not null default 'active' check (status in (
    'active', 'paused', 'completed', 'cancelled', 'failed'
  )),

  -- When to give up. The runner stops touching the goal after this
  -- timestamp regardless of status; the row is preserved for audit.
  due_at timestamptz,

  -- The runner only ticks when now() >= next_run_at. After each tick
  -- the runner sets next_run_at = now() + cooldown (default 24h, can
  -- be adjusted per goal_type).
  next_run_at timestamptz not null default now(),

  -- Free-form goal-type-specific config. For ar_collect_by_due_plus_7
  -- this might carry the dunning cadence; for missing_doc_followup the
  -- list of required document roles.
  config jsonb not null default '{}'::jsonb,

  -- The operator who armed the goal (for accountability). Service-role
  -- runs can have this null; operator-armed runs must set it.
  created_by uuid references auth.users(id) on delete set null,

  -- Owner who gets the human escalation when the agent gives up.
  owner_user_id uuid references auth.users(id) on delete set null,

  -- Bookkeeping.
  step_count int not null default 0,
  last_action_at timestamptz,
  last_action text,                                                -- e.g. 'send_reminder_email'
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_goals_runner_idx
  on agent_goals (status, next_run_at)
  where status = 'active';
create index if not exists agent_goals_tenant_idx
  on agent_goals (tenant_id, status, created_at desc);
create index if not exists agent_goals_target_idx
  on agent_goals (tenant_id, object_type, object_id);

alter table agent_goals enable row level security;

drop policy if exists "agent_goals_tenant_select" on agent_goals;
drop policy if exists "agent_goals_tenant_modify" on agent_goals;

create policy "agent_goals_tenant_select" on agent_goals
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "agent_goals_tenant_modify" on agent_goals
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);


-- agent_steps: append-only record of what the runner did at each tick.
-- Useful for the operator-facing "show your work" UI and for the eval
-- harness to grade agent behaviour over time.

create table if not exists agent_steps (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  goal_id uuid not null references agent_goals(id) on delete cascade,

  step_no int not null,                              -- 1-based, monotonic per goal
  thought text,                                       -- Claude's reasoning summary
  action text not null,                               -- 'send_email' | 'noop' | 'escalate' | 'mark_complete' | ...
  action_payload jsonb default '{}'::jsonb,           -- the full call payload, for replay
  result text,                                        -- 'ok' | 'error' | 'skipped'
  result_detail text,
  model_used text,
  tokens_in int,
  tokens_out int,
  cost_usd_cents int,
  created_at timestamptz not null default now()
);

create index if not exists agent_steps_goal_idx
  on agent_steps (goal_id, step_no desc);
create index if not exists agent_steps_tenant_idx
  on agent_steps (tenant_id, created_at desc);

alter table agent_steps enable row level security;
drop policy if exists "agent_steps_tenant_select" on agent_steps;
drop policy if exists "agent_steps_tenant_insert" on agent_steps;
create policy "agent_steps_tenant_select" on agent_steps
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "agent_steps_tenant_insert" on agent_steps
  for insert with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Trigger: keep agent_goals.updated_at fresh.
create or replace function agent_goals_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists agent_goals_updated_at on agent_goals;
create trigger agent_goals_updated_at
  before update on agent_goals
  for each row execute function agent_goals_touch_updated_at();
