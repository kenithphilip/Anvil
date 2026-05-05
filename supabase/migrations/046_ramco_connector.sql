-- 046_ramco_connector.sql
-- Phase 5.4b batch 1 cluster A (OAuth2): Ramco ERP.
--
-- Ramco exposes REST APIs through their developer portal at
-- developer.ramco.com. Auth is OAuth2 client_credentials with the
-- token endpoint configurable per tenant (varies by deployment:
-- iaas / saas / on-prem). Surface is tenant-scoped under
-- /<tenant>/api/v1/<resource>. Both XML and JSON are supported; we
-- default to JSON.
-- Idempotent.

alter table tenant_settings
  add column if not exists ramco_base_url text,
  add column if not exists ramco_token_url text,
  add column if not exists ramco_scope text default 'api',
  add column if not exists ramco_org_unit text,
  add column if not exists ramco_company text,
  add column if not exists ramco_client_id text,
  add column if not exists ramco_client_id_enc text,
  add column if not exists ramco_client_secret_enc text,
  add column if not exists ramco_creds_iv text,
  add column if not exists ramco_field_map jsonb not null default '{}'::jsonb,
  add column if not exists ramco_connected_at timestamptz;

create table if not exists ramco_customers (
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
create index if not exists ramco_customers_tenant_idx on ramco_customers (tenant_id);
alter table ramco_customers enable row level security;
drop policy if exists "ramco_customers_owner" on ramco_customers;
create policy "ramco_customers_owner" on ramco_customers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ramco_items (
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
create index if not exists ramco_items_tenant_idx on ramco_items (tenant_id);
alter table ramco_items enable row level security;
drop policy if exists "ramco_items_owner" on ramco_items;
create policy "ramco_items_owner" on ramco_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ramco_sales_orders (
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
create index if not exists ramco_sales_orders_tenant_idx on ramco_sales_orders (tenant_id, order_date desc);
alter table ramco_sales_orders enable row level security;
drop policy if exists "ramco_sales_orders_owner" on ramco_sales_orders;
create policy "ramco_sales_orders_owner" on ramco_sales_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ramco_sync_state (
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
alter table ramco_sync_state enable row level security;
drop policy if exists "ramco_sync_state_owner" on ramco_sync_state;
create policy "ramco_sync_state_owner" on ramco_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ramco_sync_runs (
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
alter table ramco_sync_runs enable row level security;
drop policy if exists "ramco_sync_runs_owner" on ramco_sync_runs;
create policy "ramco_sync_runs_owner" on ramco_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ramco_retry_queue (
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
create index if not exists ramco_retry_queue_due_idx on ramco_retry_queue (tenant_id, status, next_attempt_at);
alter table ramco_retry_queue enable row level security;
drop policy if exists "ramco_retry_queue_owner" on ramco_retry_queue;
create policy "ramco_retry_queue_owner" on ramco_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
