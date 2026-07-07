-- 166_recommended_minmax.sql
--
-- Reorder-policy bounds for the spare-matrix Recommended sheet: a min/max
-- stock level per recommended part, computed from installed_qty + the
-- item type (see src/api/_lib/spare-minmax.js):
--   - copper consumables (cap tips, shanks, shunts): bulk, near installed.
--   - expensive spares / assemblies (gear case, transformer): low (~1-4).
-- Operator-overridable, preserved across recompute like the other human
-- fields. Additive + idempotent.

alter table recommended_spares
  add column if not exists recommended_min numeric,
  add column if not exists recommended_max numeric;

comment on column recommended_spares.recommended_min is
  'Suggested minimum stock level (reorder point), computed from installed_qty + item type; operator-overridable (migration 166).';
comment on column recommended_spares.recommended_max is
  'Suggested maximum stock level, computed from installed_qty + item type; operator-overridable (migration 166).';
