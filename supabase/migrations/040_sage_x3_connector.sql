-- 040_sage_x3_connector.sql
-- Phase 5.4 batch 1: Sage X3 (Sage Enterprise Management).
--
-- Modern Sage X3 (V12+) exposes a REST API at
-- /sdata/<solution>/<endpoint>/<entity> with OAuth2 client_credentials.
-- Older deployments use SOAP via the AdxAdmin web service; we
-- document a SOAP fallback adapter but ship the REST path here.
-- Idempotent.

-- Per-tenant Sage X3 credentials live on tenant_settings, mirroring
-- the netsuite / sxe / acumatica / p21 / d365 / sap / eclipse pattern.
alter table tenant_settings
  add column if not exists sagex3_base_url text,
  add column if not exists sagex3_token_url text,
  add column if not exists sagex3_solution text default 'X3',
  add column if not exists sagex3_company text,
  add column if not exists sagex3_locale text default 'ENG',
  add column if not exists sagex3_client_id text,
  add column if not exists sagex3_client_id_enc text,
  add column if not exists sagex3_client_secret_enc text,
  add column if not exists sagex3_creds_iv text,
  add column if not exists sagex3_field_map jsonb not null default '{}'::jsonb,
  add column if not exists sagex3_connected_at timestamptz;

-- Mirror tables. We mirror what the quoting + SO push paths
-- actually need: customers, items, sales orders. Inventory and
-- shipments can follow once a real tenant lights up.
create table if not exists sagex3_customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                     -- BPC code
  name text,
  email text,
  currency text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create index if not exists sagex3_customers_tenant_idx on sagex3_customers (tenant_id);

alter table sagex3_customers enable row level security;
drop policy if exists "sagex3_customers_owner" on sagex3_customers;
create policy "sagex3_customers_owner" on sagex3_customers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists sagex3_items (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                     -- ITM code
  description text,
  base_uom text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create index if not exists sagex3_items_tenant_idx on sagex3_items (tenant_id);

alter table sagex3_items enable row level security;
drop policy if exists "sagex3_items_owner" on sagex3_items;
create policy "sagex3_items_owner" on sagex3_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists sagex3_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                     -- SOH order number
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

create index if not exists sagex3_sales_orders_tenant_idx on sagex3_sales_orders (tenant_id, order_date desc);

alter table sagex3_sales_orders enable row level security;
drop policy if exists "sagex3_sales_orders_owner" on sagex3_sales_orders;
create policy "sagex3_sales_orders_owner" on sagex3_sales_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists sagex3_sync_state (
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

alter table sagex3_sync_state enable row level security;
drop policy if exists "sagex3_sync_state_owner" on sagex3_sync_state;
create policy "sagex3_sync_state_owner" on sagex3_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Sync runs and retry queue match the canonical shape used by the
-- shared erp-runner module (see _lib/erp-runner.js).
create table if not exists sagex3_sync_runs (
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

alter table sagex3_sync_runs enable row level security;
drop policy if exists "sagex3_sync_runs_owner" on sagex3_sync_runs;
create policy "sagex3_sync_runs_owner" on sagex3_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists sagex3_retry_queue (
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

create index if not exists sagex3_retry_queue_due_idx on sagex3_retry_queue (tenant_id, status, next_attempt_at);

alter table sagex3_retry_queue enable row level security;
drop policy if exists "sagex3_retry_queue_owner" on sagex3_retry_queue;
create policy "sagex3_retry_queue_owner" on sagex3_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
