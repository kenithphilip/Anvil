-- 025_rlhf.sql
-- RLHF feedback loop. Anvil already runs an autonomous agent (v1)
-- and several Claude-driven flows (intake extraction, anomaly
-- explainer, BOM mapper, agent thoughts). RLHF gives operators a
-- structured way to upvote/downvote model outputs, attach a corrected
-- example, and aggregate the signal so we can fine-tune or build a
-- preference dataset.
-- Idempotent.

create table if not exists rlhf_feedback (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  surface text not null,                          -- 'agent','intake','anomaly','bom','quote_qa','custom'
  case_id uuid,                                   -- optional link to orders/agents/etc
  prompt jsonb,                                   -- prompt that produced the output
  output jsonb,                                   -- model output being rated
  rating smallint not null check (rating between -1 and 1),  -- -1 = bad, 0 = neutral, 1 = good
  comment text,
  corrected_output jsonb,                         -- operator's preferred output (optional)
  model text,                                     -- claude-3-5-sonnet-20241022, etc.
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists rlhf_feedback_tenant_idx on rlhf_feedback (tenant_id, created_at desc);
create index if not exists rlhf_feedback_surface_idx on rlhf_feedback (tenant_id, surface, rating);

alter table rlhf_feedback enable row level security;
drop policy if exists "rlhf_feedback_all" on rlhf_feedback;
create policy "rlhf_feedback_all" on rlhf_feedback
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Aggregated reward signal per (surface, day). Materialised by the
-- /api/rlhf/aggregate endpoint; gives the dashboard fast reads.
create table if not exists rlhf_reward_daily (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  surface text not null,
  day date not null,
  positive int not null default 0,
  negative int not null default 0,
  neutral int not null default 0,
  net_score int not null default 0,
  comments_count int not null default 0,
  corrections_count int not null default 0,
  models text[] not null default array[]::text[],
  unique (tenant_id, surface, day)
);

alter table rlhf_reward_daily enable row level security;
drop policy if exists "rlhf_reward_daily_all" on rlhf_reward_daily;
create policy "rlhf_reward_daily_all" on rlhf_reward_daily
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
