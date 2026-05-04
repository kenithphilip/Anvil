-- 031_eclipse_connector.sql
-- Epicor Eclipse (formerly Solar Eclipse). HVAC + electrical
-- distributors. Uses Eclipse Web Services (SOAP-style XML over
-- HTTPS) with a simple Basic-auth or token-auth shape. We wrap
-- the SOAP envelope in JSON so the rest of the connector matches
-- the OData ones.
-- Idempotent.

alter table tenant_settings
  add column if not exists eclipse_base_url text,
  add column if not exists eclipse_username text,
  add column if not exists eclipse_username_enc bytea,
  add column if not exists eclipse_password_enc bytea,
  add column if not exists eclipse_creds_iv bytea,
  add column if not exists eclipse_default_branch text,
  add column if not exists eclipse_default_warehouse text,
  add column if not exists eclipse_field_map jsonb default '{}'::jsonb,
  add column if not exists eclipse_connected_at timestamptz,
  add column if not exists eclipse_last_full_sync_at timestamptz;

create table if not exists eclipse_sync_state (
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
  error text, updated_at timestamptz not null default now(),
  unique (tenant_id, entity)
);

create table if not exists eclipse_sync_runs (
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

create table if not exists eclipse_retry_queue (
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

create table if not exists eclipse_customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null, name text, email text, currency text,
  is_inactive boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists eclipse_products (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  description text, base_uom text,
  is_inactive boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists eclipse_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  customer_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists eclipse_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  vendor_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists eclipse_branches (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  name text, is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

do $$
declare t text;
begin
  for t in select unnest(array[
    'eclipse_sync_state','eclipse_sync_runs','eclipse_retry_queue',
    'eclipse_customers','eclipse_products','eclipse_sales_orders',
    'eclipse_purchase_orders','eclipse_branches'])
  loop
    execute 'alter table ' || t || ' enable row level security';
    execute 'drop policy if exists "' || t || '_all" on ' || t;
    execute 'create policy "' || t || '_all" on ' || t ||
      ' for all using (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)' ||
      ' with check (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)';
  end loop;
end $$;
