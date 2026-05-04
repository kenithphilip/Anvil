-- 017_sap_connector.sql
-- SAP S/4HANA connector. Uses OAuth2 client_credentials against the
-- customer's IAS (Identity Authentication Service) tenant + OData v4
-- endpoints under /sap/opu/odata4/sap/.
--
-- Mirror tables: sap_business_partners, sap_materials,
-- sap_sales_orders, sap_purchase_orders, sap_plants, sap_currencies,
-- sap_inventory_balances.
-- Idempotent.

alter table tenant_settings
  add column if not exists sap_base_url text,                       -- https://<tenant>.s4hana.cloud.sap
  add column if not exists sap_token_url text,                      -- IAS token endpoint
  add column if not exists sap_client_id text,
  add column if not exists sap_client_id_enc bytea,
  add column if not exists sap_client_secret_enc bytea,
  add column if not exists sap_creds_iv bytea,
  add column if not exists sap_company_code text,                   -- BUKRS
  add column if not exists sap_sales_org text,                      -- VKORG
  add column if not exists sap_distribution_channel text,           -- VTWEG
  add column if not exists sap_division text,                       -- SPART
  add column if not exists sap_default_plant text,                  -- WERKS
  add column if not exists sap_field_map jsonb default '{}'::jsonb,
  add column if not exists sap_connected_at timestamptz,
  add column if not exists sap_last_full_sync_at timestamptz;

create table if not exists sap_sync_state (
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

create table if not exists sap_sync_runs (
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

create table if not exists sap_retry_queue (
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

create table if not exists sap_business_partners (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                  -- BusinessPartner number
  name text,
  email text,
  phone text,
  category text,                              -- 1=Person, 2=Org
  is_blocked boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_materials (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                  -- Material number
  description text,
  base_uom text,
  material_group text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                  -- SalesOrder number
  customer_external_id text,
  status text,
  total numeric(14,2),
  currency text,
  ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                  -- PurchaseOrder number
  vendor_external_id text,
  status text,
  total numeric(14,2),
  currency text,
  ordered_at timestamptz,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_plants (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  name text,
  is_inactive boolean default false,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_currencies (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,                  -- Currency code (USD/EUR)
  description text,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists sap_inventory_balances (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  material_external_id text not null,
  plant_external_id text,
  storage_location text,
  quantity_on_hand numeric(14,3),
  quantity_unrestricted numeric(14,3),
  base_uom text,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, material_external_id, plant_external_id, storage_location)
);

-- RLS on every table.
do $$
declare t text;
begin
  for t in select unnest(array[
    'sap_sync_state','sap_sync_runs','sap_retry_queue',
    'sap_business_partners','sap_materials','sap_sales_orders',
    'sap_purchase_orders','sap_plants','sap_currencies',
    'sap_inventory_balances'])
  loop
    execute 'alter table ' || t || ' enable row level security';
    execute 'drop policy if exists "' || t || '_all" on ' || t;
    execute 'create policy "' || t || '_all" on ' || t ||
      ' for all using (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)' ||
      ' with check (tenant_id = (current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid)';
  end loop;
end $$;

create index if not exists sap_sync_runs_tenant_idx on sap_sync_runs (tenant_id, run_started_at desc);
create index if not exists sap_retry_picker_idx on sap_retry_queue (status, next_attempt_at) where status = 'pending';
create index if not exists sap_bp_tenant_idx on sap_business_partners (tenant_id, name);
create index if not exists sap_so_tenant_idx on sap_sales_orders (tenant_id, status);
create index if not exists sap_po_tenant_idx on sap_purchase_orders (tenant_id, status);
create index if not exists sap_inv_tenant_idx on sap_inventory_balances (tenant_id, material_external_id);
