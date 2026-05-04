-- 018_dynamics_connector.sql
-- Microsoft Dynamics 365 Finance & Operations connector. OAuth2
-- against Azure AD with `resource=<dynamics_url>`, then OData /data
-- entities. Idempotent.

alter table tenant_settings
  add column if not exists d365_resource_url text,                  -- https://<env>.operations.dynamics.com
  add column if not exists d365_tenant_id text,                     -- AAD directory tenant id
  add column if not exists d365_token_url text,                     -- https://login.microsoftonline.com/<tid>/oauth2/token
  add column if not exists d365_client_id text,
  add column if not exists d365_client_id_enc bytea,
  add column if not exists d365_client_secret_enc bytea,
  add column if not exists d365_creds_iv bytea,
  add column if not exists d365_company text,                       -- DataAreaId, e.g. USMF
  add column if not exists d365_default_warehouse text,
  add column if not exists d365_default_site text,
  add column if not exists d365_field_map jsonb default '{}'::jsonb,
  add column if not exists d365_connected_at timestamptz,
  add column if not exists d365_last_full_sync_at timestamptz;

create table if not exists d365_sync_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null,
  last_sync_at timestamptz,
  last_full_sync_at timestamptz,
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

create table if not exists d365_sync_runs (
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

create table if not exists d365_retry_queue (
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

create table if not exists d365_customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null, name text, email text, phone text, currency text,
  is_blocked boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists d365_released_products (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null, description text, base_uom text,
  product_group text, is_inactive boolean default false, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists d365_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null, customer_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists d365_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null, vendor_external_id text, status text,
  total numeric(14,2), currency text, ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists d365_inventory_balances (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_external_id text not null, warehouse text, site text,
  quantity_on_hand numeric(14,3), quantity_available numeric(14,3),
  base_uom text, raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, product_external_id, warehouse, site)
);

do $$
declare t text;
begin
  for t in select unnest(array[
    'd365_sync_state','d365_sync_runs','d365_retry_queue',
    'd365_customers','d365_released_products','d365_sales_orders',
    'd365_purchase_orders','d365_inventory_balances'])
  loop
    execute 'alter table ' || t || ' enable row level security';
    execute 'drop policy if exists "' || t || '_all" on ' || t;
    execute 'create policy "' || t || '_all" on ' || t ||
      ' for all using (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)' ||
      ' with check (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)';
  end loop;
end $$;

create index if not exists d365_sync_runs_tenant_idx on d365_sync_runs (tenant_id, run_started_at desc);
create index if not exists d365_retry_picker_idx on d365_retry_queue (status, next_attempt_at) where status = 'pending';
