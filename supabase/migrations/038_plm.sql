-- 038_plm.sql
-- Phase 5.5 (Lumari parity): PLM connectors for PTC Windchill and
-- Arena PLM. Read-only mirror; we pull BOMs and engineering change
-- orders, never push. Idempotent.

-- PLM system config per tenant. We allow multiple PLM instances per
-- tenant (rare, but possible during a migration window).
create table if not exists plm_systems (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  system text not null check (system in ('windchill', 'arena')),
  display_name text,
  base_url text not null,
  -- Encrypted creds. Mirrors the pattern used by ERP clients.
  username_enc text,
  username text,                                 -- plaintext fallback when secrets not configured
  password_enc text,
  api_key_enc text,
  api_key text,                                  -- plaintext fallback
  creds_iv text,
  active boolean not null default true,
  connected_at timestamptz,
  last_error text,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, system, base_url)
);

create index if not exists plm_systems_tenant_idx on plm_systems (tenant_id, active);

alter table plm_systems enable row level security;
drop policy if exists "plm_systems_owner" on plm_systems;
create policy "plm_systems_owner" on plm_systems
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function plm_systems_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists plm_systems_updated_at on plm_systems;
create trigger plm_systems_updated_at before update on plm_systems
  for each row execute function plm_systems_touch_updated_at();

-- BOM mirror. The structure column is a tree of { part_no, qty,
-- uom, children: [...] } so we can render multilevel BOMs without
-- a recursive CTE per render.
create table if not exists plm_boms (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_system text not null check (source_system in ('windchill', 'arena')),
  external_id text not null,                     -- Windchill OID or Arena GUID
  part_number text not null,
  description text,
  revision text,
  state text,                                    -- "released", "in-work", etc.
  structure jsonb not null default '{}'::jsonb,  -- nested BOM
  flat_count integer,                            -- count of leaf parts (lazy convenience)
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_system, external_id)
);

create index if not exists plm_boms_part_idx on plm_boms (tenant_id, part_number);
create index if not exists plm_boms_synced_idx on plm_boms (tenant_id, synced_at desc);

alter table plm_boms enable row level security;
drop policy if exists "plm_boms_owner" on plm_boms;
create policy "plm_boms_owner" on plm_boms
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Engineering Change Order / Notice mirror.
create table if not exists plm_changes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_system text not null check (source_system in ('windchill', 'arena')),
  external_id text not null,
  eco_number text,
  title text,
  description text,
  status text,                                   -- e.g. "released", "open", "rejected"
  affected_parts text[] not null default '{}',
  effective_date date,
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_system, external_id)
);

create index if not exists plm_changes_status_idx on plm_changes (tenant_id, status);
create index if not exists plm_changes_synced_idx on plm_changes (tenant_id, synced_at desc);

alter table plm_changes enable row level security;
drop policy if exists "plm_changes_owner" on plm_changes;
create policy "plm_changes_owner" on plm_changes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Per-system sync state (mirrors the netsuite_sync_state shape so
-- the Admin Center can render last-sync timestamps).
create table if not exists plm_sync_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  system_id uuid not null references plm_systems(id) on delete cascade,
  entity text not null check (entity in ('boms', 'changes')),
  last_sync_at timestamptz,
  last_modified_high_water timestamptz,
  rows_pulled integer not null default 0,
  rows_updated integer not null default 0,
  status text default 'idle' check (status in ('idle', 'running', 'error')),
  last_error text,
  unique (tenant_id, system_id, entity)
);

alter table plm_sync_state enable row level security;
drop policy if exists "plm_sync_state_owner" on plm_sync_state;
create policy "plm_sync_state_owner" on plm_sync_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
