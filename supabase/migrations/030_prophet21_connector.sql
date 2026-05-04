-- 030_prophet21_connector.sql
-- Epicor Prophet 21 connector. Wedge ERP for the recommended
-- distributor ICP. P21 exposes a REST/OData API at
-- /api/v2/odata/data/<EntitySet>; auth via session token issued
-- by /api/security/token.
-- Idempotent.

alter table tenant_settings
  add column if not exists p21_base_url text,                -- https://<host>/api
  add column if not exists p21_company_id text,
  add column if not exists p21_username text,
  add column if not exists p21_username_enc bytea,
  add column if not exists p21_password_enc bytea,
  add column if not exists p21_creds_iv bytea,
  add column if not exists p21_default_branch text,
  add column if not exists p21_default_warehouse text,
  add column if not exists p21_default_salesrep text,
  add column if not exists p21_field_map jsonb default '{}'::jsonb,
  add column if not exists p21_connected_at timestamptz,
  add column if not exists p21_last_full_sync_at timestamptz;

create table if not exists p21_sync_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null,
  last_sync_at timestamptz, last_full_sync_at timestamptz,
  last_modified_high_water timestamptz,
  status text not null default 'idle' check (status in ('idle','running','error')),
  rows_pulled int not null default 0,
  records_inserted int not null default 0,
  records_updated int not null default 0,
  records_errored int not null default 0,
  error text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, entity)
);

create table if not exists p21_sync_runs (
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

create table if not exists p21_retry_queue (
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

create table if not exists p21_customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  name text, email text, phone text, currency text,
  is_inactive boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists p21_items (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  description text, base_uom text, item_class text,
  is_inactive boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists p21_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  customer_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists p21_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  vendor_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists p21_branches (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  name text, is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists p21_inventory_balances (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_external_id text not null,
  warehouse text,
  quantity_on_hand numeric(14,3),
  quantity_available numeric(14,3),
  base_uom text, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, item_external_id, warehouse)
);

do $$
declare t text;
begin
  for t in select unnest(array[
    'p21_sync_state','p21_sync_runs','p21_retry_queue',
    'p21_customers','p21_items','p21_sales_orders',
    'p21_purchase_orders','p21_branches','p21_inventory_balances'])
  loop
    execute 'alter table ' || t || ' enable row level security';
    execute 'drop policy if exists "' || t || '_all" on ' || t;
    execute 'create policy "' || t || '_all" on ' || t ||
      ' for all using (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)' ||
      ' with check (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)';
  end loop;
end $$;
