-- 085_inventory_planning.sql
--
-- Phase 1 of the inventory-planning module
-- (docs/INVENTORY_PLANNING_DESIGN.md). Adds the schema needed for
-- a demand-driven, forecast-led replenishment engine for long-lead
-- bundled items (ATD, Timer, etc.).
--
-- This migration is data-only: no functions or triggers beyond the
-- usual updated_at touch + RLS policies. The forecast / planning
-- engine ships in Phase 2; the UI in Phase 3.
--
-- Idempotent. Re-running is a no-op.

-- ===========================================================
-- 1. Extensions to item_master
-- ===========================================================

alter table item_master
  add column if not exists item_type text
    check (item_type is null or item_type in
      ('GUN','ATD','TIMER','GUN_COMPONENT','SPARE','CONSUMABLE','OTHER')),
  add column if not exists safety_stock numeric(14,2),
  add column if not exists reorder_point numeric(14,2),
  add column if not exists default_supplier_id uuid,
  add column if not exists service_level numeric(4,3)
    check (service_level is null or (service_level > 0 and service_level < 1)),
  add column if not exists planning_cadence text default 'weekly'
    check (planning_cadence in ('daily','weekly','biweekly','monthly')),
  add column if not exists demand_class text
    check (demand_class is null or demand_class in
      ('smooth','erratic','intermittent','lumpy','new')),
  add column if not exists planning_enabled boolean not null default false,
  add column if not exists holding_cost_pct_override numeric(5,4)
    check (holding_cost_pct_override is null
           or (holding_cost_pct_override > 0 and holding_cost_pct_override < 1)),
  add column if not exists coverage_period_weeks int default 12
    check (coverage_period_weeks is null
           or (coverage_period_weeks > 0 and coverage_period_weeks <= 52)),
  add column if not exists pinned_model text,
  add column if not exists inventory_authoritative_source text
    check (inventory_authoritative_source is null or inventory_authoritative_source in
      ('tally','netsuite','sap','d365','acumatica','ifs','oracle_ebs',
       'oracle_fusion','plex','jobboss','p21','eclipse','sxe','proalpha',
       'ramco','jde','sagex3','manual'));

create index if not exists item_master_planning_idx
  on item_master (tenant_id, planning_enabled, item_type)
  where planning_enabled = true;

-- ===========================================================
-- 2. Extensions to tenant_settings
-- ===========================================================

alter table tenant_settings
  add column if not exists inventory_planning_enabled boolean not null default false,
  add column if not exists inventory_default_service_level numeric(4,3) not null default 0.95
    check (inventory_default_service_level > 0 and inventory_default_service_level < 1),
  add column if not exists inventory_holding_cost_pct numeric(5,4) not null default 0.22
    check (inventory_holding_cost_pct > 0 and inventory_holding_cost_pct < 1),
  add column if not exists inventory_ordering_cost_inr numeric(14,2) not null default 5000
    check (inventory_ordering_cost_inr > 0),
  add column if not exists inventory_forecast_horizon_weeks int not null default 12
    check (inventory_forecast_horizon_weeks between 4 and 52),
  add column if not exists inventory_hysteresis_runs int not null default 2
    check (inventory_hysteresis_runs between 1 and 5),
  add column if not exists inventory_voice_severity_threshold text not null default 'critical'
    check (inventory_voice_severity_threshold in ('info','warn','bad','critical')),
  add column if not exists inventory_voice_max_per_day int not null default 3
    check (inventory_voice_max_per_day >= 0),
  add column if not exists inventory_voice_window_start time not null default '08:00',
  add column if not exists inventory_voice_window_end time not null default '20:00';

-- ===========================================================
-- 3. suppliers (NEW)
-- ===========================================================

create table if not exists suppliers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  supplier_code text not null,
  supplier_name text not null,
  country text,
  default_currency text default 'INR',
  -- Lead-time stats (refreshed by the engine).
  lead_time_days numeric(8,2),
  lead_time_stddev_days numeric(8,2),
  -- Performance stats.
  on_time_delivery_rate_90d numeric(5,4),
  partial_shipment_rate_90d numeric(5,4),
  -- Per-supplier ordering-cost override (Q4). NULL = use tenant default.
  ordering_cost_override numeric(14,2)
    check (ordering_cost_override is null or ordering_cost_override > 0),
  notes text,
  contact_email text,
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, supplier_code)
);

create index if not exists suppliers_tenant_name_idx on suppliers (tenant_id, supplier_name);

alter table suppliers enable row level security;
drop policy if exists "suppliers_select" on suppliers;
drop policy if exists "suppliers_modify" on suppliers;
create policy "suppliers_select" on suppliers
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "suppliers_modify" on suppliers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function suppliers_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists suppliers_updated_at on suppliers;
create trigger suppliers_updated_at before update on suppliers
  for each row execute function suppliers_touch_updated_at();

-- Now that suppliers exists, link the FK on item_master.
do $link_fk$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'item_master'
      and constraint_name = 'item_master_default_supplier_fk'
  ) then
    alter table item_master
      add constraint item_master_default_supplier_fk
      foreign key (default_supplier_id) references suppliers(id) on delete set null;
  end if;
end $link_fk$;

-- ===========================================================
-- 4. source_po_lines (NEW; relational extraction of source_pos.payload)
-- ===========================================================

create table if not exists source_po_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_po_id uuid not null references source_pos(id) on delete cascade,
  line_index int not null,
  part_no text not null,
  description text,
  qty numeric(14,4) not null,
  rate numeric(18,4),
  uom text,
  acknowledged_eta date,
  received_qty numeric(14,4) not null default 0,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_po_id, line_index)
);

create index if not exists source_po_lines_part_idx
  on source_po_lines (tenant_id, part_no, acknowledged_eta);
create index if not exists source_po_lines_open_idx
  on source_po_lines (tenant_id, part_no)
  where received_qty < qty;

alter table source_po_lines enable row level security;
drop policy if exists "source_po_lines_select" on source_po_lines;
drop policy if exists "source_po_lines_modify" on source_po_lines;
create policy "source_po_lines_select" on source_po_lines
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "source_po_lines_modify" on source_po_lines
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function source_po_lines_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists source_po_lines_updated_at on source_po_lines;
create trigger source_po_lines_updated_at before update on source_po_lines
  for each row execute function source_po_lines_touch_updated_at();

-- ===========================================================
-- 5. inventory_allocations (NEW)
-- ===========================================================

create table if not exists inventory_allocations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  part_no text not null,
  qty numeric(14,4) not null check (qty > 0),
  required_by date not null,
  status text not null default 'reserved'
    check (status in ('reserved','consumed','released','expired')),
  reserved_at timestamptz not null default now(),
  consumed_at timestamptz,
  released_at timestamptz,
  reason_text text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inv_alloc_part_idx on inventory_allocations
  (tenant_id, part_no, required_by, status)
  where status = 'reserved';
create index if not exists inv_alloc_project_idx on inventory_allocations
  (tenant_id, project_id);
create index if not exists inv_alloc_order_idx on inventory_allocations
  (tenant_id, order_id) where order_id is not null;

alter table inventory_allocations enable row level security;
drop policy if exists "inventory_allocations_select" on inventory_allocations;
drop policy if exists "inventory_allocations_modify" on inventory_allocations;
create policy "inventory_allocations_select" on inventory_allocations
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "inventory_allocations_modify" on inventory_allocations
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function inventory_allocations_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists inventory_allocations_updated_at on inventory_allocations;
create trigger inventory_allocations_updated_at before update on inventory_allocations
  for each row execute function inventory_allocations_touch_updated_at();

-- ===========================================================
-- 6. demand_forecasts (NEW)
-- ===========================================================

create table if not exists demand_forecasts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  week_start date not null,
  -- Decomposed (committed + pipeline + baseline). Total is generated.
  forecast_committed numeric(14,4) not null default 0,
  forecast_pipeline  numeric(14,4) not null default 0,
  forecast_baseline  numeric(14,4) not null default 0,
  forecast_total     numeric(14,4) generated always as
    (forecast_committed + forecast_pipeline + forecast_baseline) stored,
  -- Predictive distribution quantiles.
  quantile_50 numeric(14,4),
  quantile_90 numeric(14,4),
  quantile_95 numeric(14,4),
  quantile_99 numeric(14,4),
  -- Provenance.
  model_name text,
  model_version text,
  wape_4w  numeric(6,4),
  wape_8w  numeric(6,4),
  wape_12w numeric(6,4),
  generated_at timestamptz not null default now(),
  unique (tenant_id, part_no, week_start, model_name)
);

create index if not exists demand_forecasts_part_week_idx on demand_forecasts
  (tenant_id, part_no, week_start desc);

alter table demand_forecasts enable row level security;
drop policy if exists "demand_forecasts_select" on demand_forecasts;
drop policy if exists "demand_forecasts_modify" on demand_forecasts;
create policy "demand_forecasts_select" on demand_forecasts
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "demand_forecasts_modify" on demand_forecasts
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ===========================================================
-- 7. inventory_positions (NEW; daily snapshot per source)
-- ===========================================================

create table if not exists inventory_positions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  as_of date not null,
  on_hand_qty       numeric(14,4) not null default 0,
  in_transit_qty    numeric(14,4) not null default 0,
  allocated_qty     numeric(14,4) not null default 0,
  net_available_qty numeric(14,4) generated always as
    (on_hand_qty + in_transit_qty - allocated_qty) stored,
  reorder_point     numeric(14,4),
  safety_stock      numeric(14,4),
  source text not null
    check (source in
      ('tally','netsuite','sap','d365','acumatica','ifs','oracle_ebs',
       'oracle_fusion','plex','jobboss','p21','eclipse','sxe','proalpha',
       'ramco','jde','sagex3','manual','union')),
  raw_payload jsonb,
  generated_at timestamptz not null default now(),
  unique (tenant_id, part_no, as_of, source)
);

create index if not exists inventory_positions_union_idx on inventory_positions
  (tenant_id, part_no, as_of desc) where source = 'union';
create index if not exists inventory_positions_recent_idx on inventory_positions
  (tenant_id, as_of desc);

alter table inventory_positions enable row level security;
drop policy if exists "inventory_positions_select" on inventory_positions;
drop policy if exists "inventory_positions_modify" on inventory_positions;
create policy "inventory_positions_select" on inventory_positions
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "inventory_positions_modify" on inventory_positions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ===========================================================
-- 8. procurement_plans (NEW; planned-PO queue)
-- ===========================================================

create table if not exists procurement_plans (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  for_week date not null,
  recommended_order_date date not null,
  expected_arrival_date date not null,
  recommended_qty numeric(14,4) not null check (recommended_qty > 0),
  policy_source text not null default 'rule_based_eoq'
    check (policy_source in
      ('rule_based_eoq','rule_based_coverage','rl_ppo_v1','manual_override')),
  net_requirement numeric(14,4) not null,
  rationale jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in
      ('draft','approved','released','received','cancelled','superseded')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  released_source_po_id uuid references source_pos(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists procurement_plans_status_idx on procurement_plans
  (tenant_id, status, for_week);
create index if not exists procurement_plans_part_idx on procurement_plans
  (tenant_id, part_no, for_week desc);

alter table procurement_plans enable row level security;
drop policy if exists "procurement_plans_select" on procurement_plans;
drop policy if exists "procurement_plans_modify" on procurement_plans;
create policy "procurement_plans_select" on procurement_plans
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "procurement_plans_modify" on procurement_plans
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function procurement_plans_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists procurement_plans_updated_at on procurement_plans;
create trigger procurement_plans_updated_at before update on procurement_plans
  for each row execute function procurement_plans_touch_updated_at();

-- ===========================================================
-- 9. inventory_exceptions (NEW)
-- ===========================================================

create table if not exists inventory_exceptions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text,
  exception_kind text not null check (exception_kind in
    ('stockout_imminent','below_reorder_point','supplier_delay',
     'demand_spike','forecast_drift','allocation_overrun',
     'no_default_supplier','negative_position','erp_mismatch')),
  severity text not null check (severity in ('info','warn','bad','critical')),
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open','acknowledged','resolved','suppressed')),
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists inventory_exceptions_status_idx on inventory_exceptions
  (tenant_id, status, created_at desc) where status = 'open';
create index if not exists inventory_exceptions_part_idx on inventory_exceptions
  (tenant_id, part_no, created_at desc);

alter table inventory_exceptions enable row level security;
drop policy if exists "inventory_exceptions_select" on inventory_exceptions;
drop policy if exists "inventory_exceptions_modify" on inventory_exceptions;
create policy "inventory_exceptions_select" on inventory_exceptions
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "inventory_exceptions_modify" on inventory_exceptions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ===========================================================
-- 10. forecast_runs (NEW; engine provenance)
-- ===========================================================

create table if not exists forecast_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running','ok','partial_failure','failed')),
  items_count int default 0,
  models_evaluated jsonb default '{}'::jsonb,
  wape_summary jsonb default '{}'::jsonb,
  notes text
);

create index if not exists forecast_runs_recent_idx on forecast_runs
  (tenant_id, started_at desc);

alter table forecast_runs enable row level security;
drop policy if exists "forecast_runs_select" on forecast_runs;
drop policy if exists "forecast_runs_modify" on forecast_runs;
create policy "forecast_runs_select" on forecast_runs
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "forecast_runs_modify" on forecast_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ===========================================================
-- 11. v_bom_walk_recursive (recursive view for BOM unrolling)
-- ===========================================================

-- Walks a parent part's BOM down to leaves and accumulates the
-- effective qty multiplier. The depth cap at 8 prevents infinite
-- recursion if a malformed BOM has a cycle.
create or replace view v_bom_walk_recursive as
with recursive walk as (
  select
    parent_part_no as root_part_no,
    parent_part_no as ancestor_part_no,
    child_part_no,
    qty as multiplier,
    1 as depth
  from bill_of_materials
  union all
  select
    w.root_part_no,
    b.parent_part_no,
    b.child_part_no,
    w.multiplier * b.qty,
    w.depth + 1
  from walk w
  join bill_of_materials b on b.parent_part_no = w.child_part_no
  where w.depth < 8
)
select
  root_part_no,
  child_part_no,
  sum(multiplier) as total_qty
from walk
group by root_part_no, child_part_no;

-- ===========================================================
-- 12. Notes
-- ===========================================================

-- Phase 1 ships only the schema. The forecast / planning engine
-- (Phase 2) will populate these tables on a weekly cron, the UI
-- (Phase 3) will consume them. Until both ship, the tables are
-- inert: nothing reads or writes them in production.
--
-- The `opportunity_line_items` table lives in migration 086 so
-- the inventory-planning schema can ship first; the opportunity
-- restructuring is independent and lower-risk.
