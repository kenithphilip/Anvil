-- 048_plex_connector.sql
-- Phase 5.4b cluster B (token-pair): Plex Smart Manufacturing Platform.
--
-- Plex (Rockwell Automation) exposes REST + SOAP web services. Auth
-- is API-key style: a customer-id header (`X-Plex-Customer-Id`) plus
-- a bearer-style API key issued from the Plex Staff Panel. We treat
-- this as a token-pair (id + key) and cache nothing — Plex API keys
-- are long-lived per the developer portal docs.
--
-- Idempotent.

alter table tenant_settings
  add column if not exists plex_base_url text,
  add column if not exists plex_customer_id text,
  add column if not exists plex_pcn text,
  add column if not exists plex_api_key_enc text,
  add column if not exists plex_creds_iv text,
  add column if not exists plex_field_map jsonb not null default '{}'::jsonb,
  add column if not exists plex_connected_at timestamptz;

create table if not exists plex_customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  name text,
  email text,
  currency text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);
create index if not exists plex_customers_tenant_idx on plex_customers (tenant_id);
alter table plex_customers enable row level security;
drop policy if exists "plex_customers_owner" on plex_customers;
create policy "plex_customers_owner" on plex_customers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists plex_items (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  description text,
  base_uom text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);
create index if not exists plex_items_tenant_idx on plex_items (tenant_id);
alter table plex_items enable row level security;
drop policy if exists "plex_items_owner" on plex_items;
create policy "plex_items_owner" on plex_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists plex_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  customer_external_id text,
  status text,
  order_date date,
  ship_to text,
  currency text,
  total numeric(14,2),
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);
create index if not exists plex_sales_orders_tenant_idx on plex_sales_orders (tenant_id, order_date desc);
alter table plex_sales_orders enable row level security;
drop policy if exists "plex_sales_orders_owner" on plex_sales_orders;
create policy "plex_sales_orders_owner" on plex_sales_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists plex_sync_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null,
  last_sync_at timestamptz,
  last_modified_high_water timestamptz,
  rows_pulled integer not null default 0,
  rows_updated integer not null default 0,
  status text default 'idle' check (status in ('idle', 'running', 'error')),
  last_error text,
  unique (tenant_id, entity)
);
alter table plex_sync_state enable row level security;
drop policy if exists "plex_sync_state_owner" on plex_sync_state;
create policy "plex_sync_state_owner" on plex_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists plex_sync_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null,
  run_started_at timestamptz not null default now(),
  run_finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','error','partial')),
  rows_pulled int not null default 0,
  rows_inserted int not null default 0,
  rows_updated int not null default 0,
  rows_errored int not null default 0,
  high_water_after timestamptz,
  error text,
  triggered_by text not null default 'cron' check (triggered_by in ('cron','manual','retry'))
);
alter table plex_sync_runs enable row level security;
drop policy if exists "plex_sync_runs_owner" on plex_sync_runs;
create policy "plex_sync_runs_owner" on plex_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists plex_retry_queue (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  status text not null default 'pending' check (status in ('pending','succeeded','gave_up')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plex_retry_queue_due_idx on plex_retry_queue (tenant_id, status, next_attempt_at);
alter table plex_retry_queue enable row level security;
drop policy if exists "plex_retry_queue_owner" on plex_retry_queue;
create policy "plex_retry_queue_owner" on plex_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
