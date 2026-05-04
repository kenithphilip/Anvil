-- 015_netsuite_v2.sql
-- NetSuite connector hardening. Adds:
--   1. Encrypted credential storage. The five netsuite_*_secret /
--      _key / _id columns on tenant_settings stay readable as
--      ciphertext only. New _enc and _iv columns hold the AES-256-GCM
--      blobs; the plaintext columns are kept temporarily for a
--      one-shot rewrite-in-place migration in the application layer
--      and become non-functional after the rotation runs.
--   2. Per-entity cursor-based incremental sync. Each row in
--      netsuite_sync_state already had last_cursor; we now also
--      track records_skipped and a per-run audit row.
--   3. netsuite_sync_runs: one row per cron tick per entity, with the
--      pulled / inserted / updated / errored counts.
--   4. netsuite_retry_queue: failed pushes land here. Exponential
--      backoff up to 5 attempts; runner picks up rows where
--      next_attempt_at <= now().
--   5. netsuite_field_map on tenant_settings: tenant-configurable
--      override for how Anvil fields render onto NetSuite records.
--   6. Optional per-tenant company_id so a single NetSuite account
--      with multiple subsidiaries can route per Anvil tenant.
-- Idempotent.

alter table tenant_settings
  add column if not exists netsuite_consumer_key_enc bytea,
  add column if not exists netsuite_consumer_secret_enc bytea,
  add column if not exists netsuite_token_id_enc bytea,
  add column if not exists netsuite_token_secret_enc bytea,
  add column if not exists netsuite_creds_iv bytea,
  add column if not exists netsuite_subsidiary_id text,
  add column if not exists netsuite_field_map jsonb default '{}'::jsonb,
  add column if not exists netsuite_default_location_id text,
  add column if not exists netsuite_last_full_sync_at timestamptz;

-- Add cursor columns to sync state if missing.
alter table netsuite_sync_state
  add column if not exists last_full_sync_at timestamptz,
  add column if not exists last_modified_high_water timestamptz,
  add column if not exists records_inserted int not null default 0,
  add column if not exists records_updated  int not null default 0,
  add column if not exists records_errored  int not null default 0;

-- Sync run audit. One row per (tenant, entity, run_started_at).
create table if not exists netsuite_sync_runs (
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

create index if not exists netsuite_sync_runs_tenant_idx
  on netsuite_sync_runs (tenant_id, run_started_at desc);
create index if not exists netsuite_sync_runs_entity_idx
  on netsuite_sync_runs (tenant_id, entity, run_started_at desc);

alter table netsuite_sync_runs enable row level security;
drop policy if exists "ns_sync_runs_select" on netsuite_sync_runs;
drop policy if exists "ns_sync_runs_modify" on netsuite_sync_runs;
create policy "ns_sync_runs_select" on netsuite_sync_runs
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ns_sync_runs_modify" on netsuite_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Push retry queue. A row goes here whenever /api/netsuite/push hits
-- a recoverable error (5xx, 429, network). The cron picks them up at
-- next_attempt_at and retries with exponential backoff. After
-- max_attempts, status flips to 'gave_up' and an alert event fires.
create table if not exists netsuite_retry_queue (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  status text not null default 'pending' check (status in ('pending','succeeded','gave_up')),
  netsuite_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists netsuite_retry_queue_picker_idx
  on netsuite_retry_queue (status, next_attempt_at)
  where status = 'pending';
create index if not exists netsuite_retry_queue_tenant_idx
  on netsuite_retry_queue (tenant_id, created_at desc);
create index if not exists netsuite_retry_queue_order_idx
  on netsuite_retry_queue (tenant_id, order_id);

alter table netsuite_retry_queue enable row level security;
drop policy if exists "ns_retry_select" on netsuite_retry_queue;
drop policy if exists "ns_retry_modify" on netsuite_retry_queue;
create policy "ns_retry_select" on netsuite_retry_queue
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ns_retry_modify" on netsuite_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function netsuite_retry_queue_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists netsuite_retry_queue_updated_at on netsuite_retry_queue;
create trigger netsuite_retry_queue_updated_at before update on netsuite_retry_queue
  for each row execute function netsuite_retry_queue_touch_updated_at();

-- Mirror tables for the new entities. Customers + items already
-- upsert into existing tables; the rest go into dedicated mirrors so
-- we don't conflict with any existing schema.

create table if not exists netsuite_vendors (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  netsuite_id text not null,
  name text,
  email text,
  phone text,
  category text,
  is_inactive boolean not null default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, netsuite_id)
);
create index if not exists netsuite_vendors_tenant_idx on netsuite_vendors (tenant_id, name);
alter table netsuite_vendors enable row level security;
drop policy if exists "ns_vendors_all" on netsuite_vendors;
create policy "ns_vendors_all" on netsuite_vendors
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists netsuite_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  netsuite_id text not null,
  tranid text,
  vendor_netsuite_id text,
  status text,
  total numeric(14,2),
  currency text,
  ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, netsuite_id)
);
create index if not exists netsuite_pos_tenant_idx on netsuite_purchase_orders (tenant_id, status);
alter table netsuite_purchase_orders enable row level security;
drop policy if exists "ns_pos_all" on netsuite_purchase_orders;
create policy "ns_pos_all" on netsuite_purchase_orders
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists netsuite_locations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  netsuite_id text not null,
  name text,
  is_inactive boolean not null default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, netsuite_id)
);
alter table netsuite_locations enable row level security;
drop policy if exists "ns_locations_all" on netsuite_locations;
create policy "ns_locations_all" on netsuite_locations
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists netsuite_currencies (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  netsuite_id text not null,
  symbol text,
  exchange_rate numeric(14,6),
  is_base_currency boolean not null default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, netsuite_id)
);
alter table netsuite_currencies enable row level security;
drop policy if exists "ns_currencies_all" on netsuite_currencies;
create policy "ns_currencies_all" on netsuite_currencies
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Inventory balances per (item, location). We don't try to mirror
-- the full SuiteQL inventoryitemlocations join model; just the
-- numbers operators need to see.
create table if not exists netsuite_inventory_balances (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_netsuite_id text not null,
  location_netsuite_id text,
  quantity_on_hand numeric(14,3),
  quantity_available numeric(14,3),
  quantity_committed numeric(14,3),
  reorder_point numeric(14,3),
  synced_at timestamptz not null default now(),
  unique (tenant_id, item_netsuite_id, location_netsuite_id)
);
create index if not exists netsuite_inventory_tenant_idx on netsuite_inventory_balances (tenant_id, item_netsuite_id);
alter table netsuite_inventory_balances enable row level security;
drop policy if exists "ns_inventory_all" on netsuite_inventory_balances;
create policy "ns_inventory_all" on netsuite_inventory_balances
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
