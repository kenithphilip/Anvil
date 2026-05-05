-- 041_voice.sql
-- Phase 5.1: voice agent. Buy-not-build via Vapi or Retell. Both
-- provide a managed PSTN number, real-time speech-to-text, and a
-- webhook contract for call events + transcripts. We persist the
-- canonical lifecycle locally so audit, dispute resolution, and
-- training datasets work the same regardless of which provider a
-- tenant chooses.
-- Idempotent.

-- Per-tenant config. Stored on a dedicated table (rather than
-- tenant_settings) because per-tenant voice is opt-in and few
-- tenants will configure both Vapi AND Retell. Multiple numbers
-- per tenant are allowed (e.g. one inbound, one outbound).
create table if not exists voice_configs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('vapi', 'retell')),
  display_name text,
  -- Provider's per-account secret (Vapi server key / Retell API key).
  api_key_enc text,
  api_key text,                                  -- plaintext fallback
  creds_iv text,
  -- Webhook signing secret the provider includes on every callback.
  webhook_secret text,
  -- Phone number leased through the provider. E.164 format.
  phone_number text,
  -- The agent / assistant id the provider uses for this number.
  assistant_id text,
  -- Voice persona + system prompt template. Kept on Anvil so a
  -- prompt change doesn't require a provider redeploy.
  voice_persona text,
  system_prompt text,
  -- Where to forward when the agent escalates.
  handoff_phone_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, phone_number)
);

create index if not exists voice_configs_tenant_idx on voice_configs (tenant_id, active);

alter table voice_configs enable row level security;
drop policy if exists "voice_configs_owner" on voice_configs;
create policy "voice_configs_owner" on voice_configs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function voice_configs_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists voice_configs_updated_at on voice_configs;
create trigger voice_configs_updated_at before update on voice_configs
  for each row execute function voice_configs_touch_updated_at();

-- One row per call. Created on call-started, updated on each event,
-- finalised on call-ended.
create table if not exists voice_calls (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  config_id uuid references voice_configs(id) on delete set null,
  provider text not null,
  external_id text not null,                     -- provider's call id
  direction text not null check (direction in ('inbound', 'outbound')),
  customer_id uuid references customers(id) on delete set null,
  caller_phone_number text,
  callee_phone_number text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds int,
  status text not null default 'in_progress' check (status in
    ('in_progress', 'completed', 'failed', 'escalated')),
  transcript jsonb default '[]'::jsonb,           -- [{role, text, ts}]
  summary text,
  -- Structured outputs the agent extracted during the call (e.g.
  -- order request, delivery enquiry).
  action_extracted jsonb default '{}'::jsonb,
  raw jsonb default '{}'::jsonb,
  unique (tenant_id, provider, external_id)
);

create index if not exists voice_calls_tenant_idx on voice_calls (tenant_id, started_at desc);
create index if not exists voice_calls_status_idx on voice_calls (tenant_id, status);
create index if not exists voice_calls_customer_idx on voice_calls (tenant_id, customer_id);

alter table voice_calls enable row level security;
drop policy if exists "voice_calls_owner" on voice_calls;
create policy "voice_calls_owner" on voice_calls
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Discrete actions emitted by the agent during the call. One call
-- can produce multiple actions (e.g. place an order AND set a
-- delivery reminder). The completed flag tracks whether the
-- downstream Anvil action (e.g. orders.create) succeeded.
create table if not exists voice_call_actions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  call_id uuid not null references voice_calls(id) on delete cascade,
  action text not null check (action in
    ('place_order', 'quote_request', 'check_delivery', 'verify_customer', 'escalate', 'note')),
  payload jsonb not null default '{}'::jsonb,
  completed boolean not null default false,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists voice_call_actions_call_idx on voice_call_actions (call_id);
create index if not exists voice_call_actions_pending_idx on voice_call_actions (tenant_id, completed) where completed = false;

alter table voice_call_actions enable row level security;
drop policy if exists "voice_call_actions_owner" on voice_call_actions;
create policy "voice_call_actions_owner" on voice_call_actions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
