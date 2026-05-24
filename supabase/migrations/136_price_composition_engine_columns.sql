-- Extend price_composition_lines for the configurable pricing engine.
--
-- Migration 106 created the table around the old compact (mod1/2/3)
-- model. The engine (lib/pricing.ts + api/_lib/pricing.js) persists a
-- richer, reproducible record: which profile was used, the frozen FX
-- snapshot, the evaluated waterfall, the realized margin, the floor it
-- was checked against, and the per-line freight inputs. All additive
-- and idempotent.

alter table price_composition_lines
  add column if not exists profile_code text,
  add column if not exists fx_snapshot jsonb,
  add column if not exists waterfall jsonb,
  add column if not exists margin_realized numeric(8, 6),
  add column if not exists margin_floor numeric(8, 6),
  add column if not exists weight_kg numeric(18, 4),
  add column if not exists volume_cbm numeric(18, 4),
  add column if not exists discount_pct numeric(8, 6),
  add column if not exists warnings jsonb;

comment on column price_composition_lines.waterfall is
  'Evaluated cost-component steps from composePrice, frozen for reproducibility and audit.';
comment on column price_composition_lines.margin_realized is
  'Realized margin (final - loaded)/final after FX, overheads and discount; gated against margin_floor.';
