-- 176_dense_history_flag.sql
--
-- Per-tenant opt-in flag that fixes the demand-history CADENCE bug in the weekly
-- inventory-planning engine. See docs/RELIABILITY_DEMAND_DESIGN.md (deferred fix)
-- and the header comment on buildHistory / the histArr assembly.
--
-- The bug: histArr was built from a SPARSE week map (sorted non-zero weeks, then
-- left-padded with zeros), so interior + trailing zero-weeks between demand events
-- collapsed. classifyDemand is unaffected (same length + non-zero values), but
-- Croston/SBA/TSB read the INTERVAL between non-zero weeks -- with the values
-- adjacent, the interval looks ~1, so intermittent parts are systematically
-- OVER-forecast. The fix rebuilds a dense weekly grid with true spacing.
--
-- LANDS DARK. Defaults false, like inventory_conformal_enabled (mig 100) and
-- reliability_demand_enabled (mig 175). With the flag off (every existing tenant)
-- the cron uses the original sparse-pad path -- every forecast/safety-stock value
-- is byte-identical to today. The correct cadence MATERIALLY changes forecasts for
-- parts with real demand gaps: most sharply it fixes TSB (the sparse path pins the
-- last demand at the array end, so demand-probability never decays and TSB always
-- over-forecasts) and the last-4-week tail (avg4w) -- both drop; Croston/SBA shift
-- either way by frequency; densely-demanded parts are unchanged. Because it moves
-- procurement-driving numbers, it is deliberately opt-in + piloted, not a silent
-- all-tenant change.
--
-- Idempotent. Applied manually -- merged != applied.

alter table tenant_settings
  add column if not exists inventory_dense_history_enabled boolean not null default false;

comment on column tenant_settings.inventory_dense_history_enabled is
  'When true, the planning cron builds demand history as a dense weekly grid (real interior/trailing zeros) instead of the sparse-pad path, fixing Croston/SBA/TSB interval + recent-tail distortion for parts with demand gaps. Default false = unchanged forecasts. Materially changes procurement-driving numbers (notably lowers TSB + avg4w), so pilot before rollout.';
