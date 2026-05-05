-- 047_jde_connector.sql
-- Phase 5.4b cluster B (token-pair): JD Edwards EnterpriseOne (AIS).
--
-- JDE EnterpriseOne exposes the AIS Server REST API; auth is
-- HTTP Basic (or JWT in 9.2.4+) to /jderest/v3/tokenrequest, which
-- returns an AIS session token used on subsequent calls. Headers
-- jde-AIS-Auth-Environment / Role / Device pin the session to a
-- specific JDE login context.
-- Idempotent.

alter table tenant_settings
  add column if not exists jde_base_url text,
  add column if not exists jde_environment text,
  add column if not exists jde_role text,
  add column if not exists jde_device text default 'Anvil',
  add column if not exists jde_username text,
  add column if not exists jde_username_enc text,
  add column if not exists jde_password_enc text,
  add column if not exists jde_creds_iv text,
  add column if not exists jde_field_map jsonb not null default '{}'::jsonb,
  add column if not exists jde_connected_at timestamptz;

create table if not exists jde_customers (
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
create index if not exists jde_customers_tenant_idx on jde_customers (tenant_id);
alter table jde_customers enable row level security;
drop policy if exists "jde_customers_owner" on jde_customers;
create policy "jde_customers_owner" on jde_customers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists jde_items (
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
create index if not exists jde_items_tenant_idx on jde_items (tenant_id);
alter table jde_items enable row level security;
drop policy if exists "jde_items_owner" on jde_items;
create policy "jde_items_owner" on jde_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists jde_sales_orders (
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
create index if not exists jde_sales_orders_tenant_idx on jde_sales_orders (tenant_id, order_date desc);
alter table jde_sales_orders enable row level security;
drop policy if exists "jde_sales_orders_owner" on jde_sales_orders;
create policy "jde_sales_orders_owner" on jde_sales_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists jde_sync_state (
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
alter table jde_sync_state enable row level security;
drop policy if exists "jde_sync_state_owner" on jde_sync_state;
create policy "jde_sync_state_owner" on jde_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists jde_sync_runs (
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
alter table jde_sync_runs enable row level security;
drop policy if exists "jde_sync_runs_owner" on jde_sync_runs;
create policy "jde_sync_runs_owner" on jde_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists jde_retry_queue (
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
create index if not exists jde_retry_queue_due_idx on jde_retry_queue (tenant_id, status, next_attempt_at);
alter table jde_retry_queue enable row level security;
drop policy if exists "jde_retry_queue_owner" on jde_retry_queue;
create policy "jde_retry_queue_owner" on jde_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
