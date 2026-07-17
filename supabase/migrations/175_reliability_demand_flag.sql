-- 175_reliability_demand_flag.sql
--
-- Spare Intelligence STEP 4b: per-tenant opt-in flag that wires the failure_events
-- stream (step 4a, migration 174) into the weekly inventory-planning engine --
-- (1) blending field-consumption into the trained demand history and (2) adding a
-- reliability safety-stock floor. See docs/RELIABILITY_DEMAND_DESIGN.md.
--
-- LANDS DARK. Defaults false, exactly like inventory_conformal_enabled (mig 100),
-- so with the flag off (every existing tenant) buildHistory returns the exact
-- schedule-only history and safetyStock() gets reliabilityFloor=0 -- every
-- forecast / safety-stock / reorder-point value is byte-identical to today. The
-- feature cannot move any number until a tenant flips this flag.
--
-- tenant_settings is the canonical one-row-per-tenant config table (013_stripe.sql);
-- the planning cron already reads the whole row with one select("*"), so a new
-- column costs zero extra queries. Idempotent. Applied manually -- merged != applied.

alter table tenant_settings
  add column if not exists reliability_demand_enabled boolean not null default false;

comment on column tenant_settings.reliability_demand_enabled is
  'Step 4b: when true, failure_events field-consumption is blended into planning demand history and a reliability safety-stock floor is applied. Default false = unchanged forecast/safety-stock for existing tenants. See docs/RELIABILITY_DEMAND_DESIGN.md.';
