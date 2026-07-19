-- 179_locations_meio_foundation.sql
--
-- Spare Intelligence STEP 4d, PHASE A: the additive location foundation for MEIO
-- (multi-echelon inventory optimization) -- friction #3 (the T3 engine is single-
-- location). See docs/MEIO_DESIGN.md.
--
-- LANDS DARK / ZERO behavior change. This migration ONLY:
--   1. adds a `locations` stocking-location master (there was none -- only the
--      customer-side customer_locations existed),
--   2. adds a NULLABLE location_id FK to the 6 transactional planning tables, with
--      their UNIQUE KEYS LEFT UNCHANGED, so the planning cron keeps writing
--      location_id = NULL (one implicit location) and every dedup + plan output is
--      byte-identical to today, and
--   3. adds tenant_settings.inventory_meio_enabled (default false), the dark master
--      switch, mirroring inventory_conformal_enabled / reliability_demand_enabled /
--      inventory_dense_history_enabled.
--
-- Per-location PLANNING (the cron fan-out) and the echelon/transfer optimizer are
-- Phase B/C -- deferred. item_master's per-part safety_stock/reorder_point scalars
-- are NOT given a location_id here; their per-(part,location) home is a Phase-B
-- table, not a column on the part master.
--
-- Idempotent. Applied manually -- merged != applied.

-- 1. locations -- internal stocking-location master (modeled on customer_locations,
--    006). Each warehouse carries its own GSTIN/state for Indian tax on future
--    internal transfers.
create table if not exists locations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_code text not null,
  name text,
  location_type text,                 -- warehouse | plant | depot | store | ...
  gstin text,
  state_code text,
  address_line1 text,
  address_line2 text,
  city text,
  pincode text,
  is_default boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, location_code)
);
create index if not exists locations_idx on locations (tenant_id);

alter table locations enable row level security;
drop policy if exists locations_select on locations;
create policy locations_select on locations
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists locations_write on locations;
create policy locations_write on locations
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- 2. Nullable location_id on the 6 transactional planning tables. UNIQUE KEYS
--    UNCHANGED -- the engine writes NULL today, so nothing dedups differently.
alter table inventory_positions              add column if not exists location_id uuid references locations(id) on delete set null;
alter table demand_forecasts                 add column if not exists location_id uuid references locations(id) on delete set null;
alter table procurement_plans                add column if not exists location_id uuid references locations(id) on delete set null;
alter table inventory_exceptions             add column if not exists location_id uuid references locations(id) on delete set null;
alter table conformal_calibration_residuals  add column if not exists location_id uuid references locations(id) on delete set null;
alter table inventory_allocations            add column if not exists location_id uuid references locations(id) on delete set null;

create index if not exists inventory_positions_location_idx  on inventory_positions (tenant_id, location_id);
create index if not exists demand_forecasts_location_idx     on demand_forecasts (tenant_id, location_id);
create index if not exists procurement_plans_location_idx    on procurement_plans (tenant_id, location_id);
create index if not exists inventory_exceptions_location_idx on inventory_exceptions (tenant_id, location_id);
create index if not exists inventory_allocations_location_idx on inventory_allocations (tenant_id, location_id);

-- 3. Dark master switch. Off by default -> the planning cron ignores location_id.
alter table tenant_settings
  add column if not exists inventory_meio_enabled boolean not null default false;

comment on table locations is
  'MEIO step 4d (Phase A): internal stocking-location master (warehouse/plant/depot). Nullable location_id on the transactional planning tables references this; per-location planning is Phase B, gated by tenant_settings.inventory_meio_enabled. See docs/MEIO_DESIGN.md.';
comment on column tenant_settings.inventory_meio_enabled is
  'MEIO master switch (Phase B+). Default false -> planning is single-location and ignores location_id. See docs/MEIO_DESIGN.md.';
