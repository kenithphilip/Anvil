-- 145_freight_consolidation.sql
-- Forecasting-driven procurement P4 (logistics LCL/FCL freight bidding).
--
-- The planner already emits procurement_plans (P2) keyed by part + week
-- with an origin (item_master.source_country). P4 turns that pipeline-
-- driven preorder into freight action: aggregate plans by origin lane +
-- arrival week into a container-fill estimate, then run a freight bid
-- (RFQ) so the logistics team can solicit and award LCL/FCL ocean quotes
-- before the goods are even ordered.
--
-- Per-part shipping dimensions live on item_master (added here,
-- additive + nullable) so the consolidation can compute weight/volume.

alter table item_master
  add column if not exists weight_kg numeric(18, 4),
  add column if not exists volume_cbm numeric(18, 6);

comment on column item_master.weight_kg is 'Per-unit shipping weight (kg). Used by P4 freight consolidation.';
comment on column item_master.volume_cbm is 'Per-unit shipping volume (cbm). Used by P4 freight consolidation.';

-- A consolidation: all procurement plans for one origin lane + arrival
-- window, rolled into an estimated container fill.
create table if not exists freight_consolidations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  mode text not null default 'ocean' check (mode in ('ocean', 'air', 'road')),
  origin text,                               -- ISO-2 country / port of loading
  destination text,                          -- ISO-2 country / port of discharge
  window_week date not null,                 -- arrival/demand week the plans share
  weight_kg numeric(18, 4) not null default 0,
  volume_cbm numeric(18, 6) not null default 0,
  containers jsonb not null default '{}'::jsonb,  -- { fcl_40, fcl_20, lcl_cbm, lcl_kg, recommended_mode }
  plan_ids uuid[] not null default array[]::uuid[],
  parts jsonb not null default '[]'::jsonb,   -- [{ part_no, qty }]
  status text not null default 'open'
    check (status in ('open', 'bidding', 'awarded', 'shipped', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, mode, origin, destination, window_week)
);

create index if not exists freight_consolidations_idx
  on freight_consolidations (tenant_id, status, window_week);

-- A bid (quote) from a carrier / forwarder against a consolidation.
create table if not exists freight_bids (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  consolidation_id uuid not null references freight_consolidations(id) on delete cascade,
  carrier text not null,                     -- carrier / forwarder name
  service text,                              -- 'LCL' | 'FCL_20' | 'FCL_40' | 'mixed'
  unit text,                                 -- 'cbm' | 'container_20ft' | 'container_40ft' | 'lumpsum'
  rate_per_unit numeric(18, 4),
  total_cost numeric(18, 2),
  currency text not null default 'USD',
  transit_days int,
  valid_until date,
  status text not null default 'pending'
    check (status in ('pending', 'awarded', 'rejected', 'withdrawn')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists freight_bids_consolidation_idx
  on freight_bids (tenant_id, consolidation_id, status);

alter table freight_consolidations enable row level security;
drop policy if exists freight_consolidations_select on freight_consolidations;
create policy freight_consolidations_select on freight_consolidations
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists freight_consolidations_write on freight_consolidations;
create policy freight_consolidations_write on freight_consolidations
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table freight_bids enable row level security;
drop policy if exists freight_bids_select on freight_bids;
create policy freight_bids_select on freight_bids
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists freight_bids_write on freight_bids;
create policy freight_bids_write on freight_bids
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table freight_consolidations is
  'P4: procurement plans aggregated by origin lane + arrival week into a container-fill estimate for ocean LCL/FCL freight bidding.';
comment on table freight_bids is
  'P4: carrier/forwarder quotes against a freight consolidation; one is awarded.';
