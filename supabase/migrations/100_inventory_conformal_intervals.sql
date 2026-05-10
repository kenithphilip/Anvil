-- 100_inventory_conformal_intervals.sql
--
-- Bet 3: conformal-prediction safety stock. Adds non-parametric
-- prediction intervals (NEXCP / Split CP / pooled cold-start)
-- alongside the existing parametric (ssNormal / ssGamma) safety
-- stock. Goal: replace fixed-quantile output with a CP band that
-- gives an empirical coverage guarantee on lumpy / intermittent
-- demand, where parametric assumptions break down hardest.
--
-- All columns are additive and nullable. The cron picks CP only
-- when:
--
--   tenant_settings.inventory_conformal_enabled = true
--   AND >= 12 nonzero residuals on the SKU
--
-- otherwise it falls through to the parametric path. So this
-- migration is safe to land before any tenant opts in.
--
-- Per docs/STRATEGIC_BET_03_conformal_safety_stock.md.
--
-- Idempotent.

-- 1. Per-forecast CP fields. Mirrored on procurement_plans so
-- downstream consumers (the planning UI, the API surface) can read
-- either side.

alter table demand_forecasts
  add column if not exists conformal_method text,
  add column if not exists coverage_target numeric(4,3),
  add column if not exists interval_lo numeric(14,4),
  add column if not exists interval_hi numeric(14,4),
  add column if not exists calibration_residuals_count int;

alter table demand_forecasts
  drop constraint if exists demand_forecasts_conformal_method_check;
alter table demand_forecasts
  add constraint demand_forecasts_conformal_method_check
  check (conformal_method is null or conformal_method in (
    'split_cp',           -- exchangeability assumed, short history
    'nexcp',              -- non-exchangeable EW-weighted residuals
    'enbpi',              -- future: bootstrap ensemble; not used today
    'block_cp',           -- future: block-permutation for time series
    'pooled_cold_start',  -- new SKU; pools residuals across item_type cohort
    'parametric_legacy'   -- gamma / normal-z fallback (CP disabled)
  ));

alter table demand_forecasts
  drop constraint if exists demand_forecasts_coverage_target_check;
alter table demand_forecasts
  add constraint demand_forecasts_coverage_target_check
  check (coverage_target is null or (coverage_target > 0.5 and coverage_target < 1));

alter table demand_forecasts
  drop constraint if exists demand_forecasts_residuals_count_check;
alter table demand_forecasts
  add constraint demand_forecasts_residuals_count_check
  check (calibration_residuals_count is null or calibration_residuals_count >= 0);

alter table procurement_plans
  add column if not exists conformal_method text,
  add column if not exists coverage_target numeric(4,3),
  add column if not exists interval_lo numeric(14,4),
  add column if not exists interval_hi numeric(14,4),
  add column if not exists calibration_residuals_count int;

-- 2. Per-SKU overrides on item_master. coverage_target is preferred
-- naming going forward; the legacy `service_level` column stays in
-- place for one release cycle and is treated as a synonym in the
-- engine.

alter table item_master
  add column if not exists conformal_coverage numeric(4,3),
  add column if not exists conformal_method_override text;

alter table item_master
  drop constraint if exists item_master_conformal_coverage_check;
alter table item_master
  add constraint item_master_conformal_coverage_check
  check (conformal_coverage is null or (conformal_coverage > 0.5 and conformal_coverage < 1));

-- 3. Tenant-level master switch + default coverage. Default OFF so
-- the existing parametric path is unchanged for every tenant until
-- they opt in.

alter table tenant_settings
  add column if not exists inventory_conformal_enabled boolean not null default false,
  add column if not exists inventory_conformal_default_coverage numeric(4,3) not null default 0.95,
  add column if not exists inventory_conformal_method text not null default 'nexcp';

alter table tenant_settings
  drop constraint if exists tenant_settings_conformal_method_check;
alter table tenant_settings
  add constraint tenant_settings_conformal_method_check
  check (inventory_conformal_method in ('nexcp', 'split_cp'));

alter table tenant_settings
  drop constraint if exists tenant_settings_conformal_coverage_check;
alter table tenant_settings
  add constraint tenant_settings_conformal_coverage_check
  check (inventory_conformal_default_coverage > 0.5
         and inventory_conformal_default_coverage < 1);

-- 4. Per-SKU rolling residuals. Each row is one (part, week)
-- observation: what we forecast vs. what actually shipped. NEXCP
-- weights are stored at write time so the calibration cron can
-- decay them deterministically without re-deriving from index.

create table if not exists conformal_calibration_residuals (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  forecast_run_id uuid references forecast_runs(id) on delete set null,
  week_start date not null,
  forecast_value numeric(14,4) not null,
  actual_value numeric(14,4) not null,
  residual numeric(14,4) generated always as
    (actual_value - forecast_value) stored,
  weight numeric(8,6) not null default 1.0,
  created_at timestamptz not null default now(),
  unique (tenant_id, part_no, week_start)
);

create index if not exists ccr_part_idx
  on conformal_calibration_residuals (tenant_id, part_no, week_start desc);

alter table conformal_calibration_residuals enable row level security;
drop policy if exists "ccr_select" on conformal_calibration_residuals;
drop policy if exists "ccr_modify" on conformal_calibration_residuals;
create policy "ccr_select" on conformal_calibration_residuals
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ccr_modify" on conformal_calibration_residuals
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 5. Comments for documentation.

comment on column demand_forecasts.conformal_method is
  'Bet 3: which CP method produced the interval. split_cp = exchangeable, nexcp = non-exchangeable EW-weighted (default), pooled_cold_start = cohort pool for new SKUs, parametric_legacy = ssGamma/ssNormal fallback.';
comment on column demand_forecasts.coverage_target is
  'Bet 3: nominal coverage target alpha (e.g. 0.95 = 95%). Per-SKU item_master.conformal_coverage overrides tenant default.';
comment on column demand_forecasts.interval_lo is
  'Bet 3: lower bound of the CP interval over the lead-time window, clamped at zero.';
comment on column demand_forecasts.interval_hi is
  'Bet 3: upper bound of the CP interval; safety_stock = interval_hi - E[LTD].';
comment on column demand_forecasts.calibration_residuals_count is
  'Bet 3: number of nonzero residuals fed into the CP estimate. < 12 routes to pooled_cold_start; 12-25 routes to split_cp; >= 26 uses NEXCP.';
comment on column tenant_settings.inventory_conformal_enabled is
  'Bet 3: master switch. When false, planning cron uses the legacy parametric path (unchanged behaviour).';
comment on column tenant_settings.inventory_conformal_default_coverage is
  'Bet 3: tenant-wide default for SKUs without item_master.conformal_coverage. 0.95 maps to a 95% prediction interval.';
comment on table conformal_calibration_residuals is
  'Bet 3: per-(tenant, part, week) actual-vs-forecast pair feeding NEXCP/Split CP. Pruned to 156 weeks (3 years) by conformal-calibration-weekly cron.';
