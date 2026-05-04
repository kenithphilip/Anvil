-- 014_netsuite.sql
-- NetSuite connector schema. Each tenant has their own NetSuite
-- account; credentials live on tenant_settings (alongside Stripe).
-- The actual sync state lives on netsuite_sync_state with one row
-- per (tenant, entity).
--
-- Auth model: TBA (token-based), NetSuite's most-supported integration
-- pattern. Consumer key/secret + token id/secret. We do not implement
-- OAuth 2.0 in v1.
--
-- Idempotent.

-- Add NetSuite columns to tenant_settings (created in 013).
alter table tenant_settings
  add column if not exists netsuite_account_id text,
  add column if not exists netsuite_consumer_key text,
  add column if not exists netsuite_consumer_secret text,
  add column if not exists netsuite_token_id text,
  add column if not exists netsuite_token_secret text,
  add column if not exists netsuite_connected_at timestamptz;

-- Sync state per (tenant, entity). The cron at /api/netsuite/sync
-- walks each entity for every tenant with non-null
-- netsuite_account_id and writes here.
create table if not exists netsuite_sync_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null check (entity in (
    'customer', 'item', 'inventory', 'sales_order', 'invoice', 'ar_aging'
  )),
  last_sync_at timestamptz,
  last_cursor text,
  status text not null default 'idle' check (status in ('idle', 'running', 'error')),
  rows_pulled int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, entity)
);

create index if not exists netsuite_sync_state_tenant_idx
  on netsuite_sync_state (tenant_id, entity);

alter table netsuite_sync_state enable row level security;
drop policy if exists "ns_sync_select" on netsuite_sync_state;
drop policy if exists "ns_sync_modify" on netsuite_sync_state;
create policy "ns_sync_select" on netsuite_sync_state
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ns_sync_modify" on netsuite_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- A tiny mirror of NetSuite's open SOs so the live-ERP-query surface
-- has something to read without round-tripping NetSuite on every
-- screen render. Filled by /api/netsuite/sync. We do not mirror
-- customers/items into separate tables; those upsert into the
-- existing customers + item_master tables.
create table if not exists netsuite_open_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  netsuite_id text not null,
  order_number text,
  customer_name text,
  status text,
  total numeric(14, 2),
  currency text,
  ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, netsuite_id)
);

create index if not exists netsuite_open_orders_tenant_idx
  on netsuite_open_orders (tenant_id, status, synced_at desc);

alter table netsuite_open_orders enable row level security;
drop policy if exists "ns_open_orders_select" on netsuite_open_orders;
drop policy if exists "ns_open_orders_modify" on netsuite_open_orders;
create policy "ns_open_orders_select" on netsuite_open_orders
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ns_open_orders_modify" on netsuite_open_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
