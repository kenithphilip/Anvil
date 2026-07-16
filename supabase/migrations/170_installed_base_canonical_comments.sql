-- 170_installed_base_canonical_comments.sql
--
-- Step 1 of the Spare Intelligence bridge (docs/INSTALLED_BASE_CANONICAL.md):
-- record the canonical installed-base grain decision in the DB catalog. This is
-- DOCUMENT-ONLY -- pure COMMENT ON metadata, no structural or data change, fully
-- reversible, and safe to re-run (COMMENT ON overwrites). No kit.js change, no
-- table drop, no data migration (those are a deferred, separately-reviewed step).

-- Canonical INSTALLED_BASE: the Part x Asset-instance hinge.
comment on table equipment_installed_parts is
  'CANONICAL INSTALLED_BASE (Part x equipment-instance). The type<->instance hinge between item_master (PRODUCT/type) and equipment_hierarchy (ASSET/instance). See docs/INSTALLED_BASE_CANONICAL.md.';

-- Deprecated: redundant with a COUNT over equipment_hierarchy gun instances.
comment on table installed_base is
  'DEPRECATED (redundant). customer x gun_model asset population, derivable as a COUNT over equipment_hierarchy gun instances. Canonical installed-base is equipment_installed_parts. Read only by spare_matrix/kit.js today; not dropped yet. See docs/INSTALLED_BASE_CANONICAL.md.';

-- Clarify: a derived worksheet aggregate, NOT an installed-base source of truth.
comment on column recommended_spares.installed_qty is
  'Derived worksheet aggregate (COUNT of this part across gun rows in the spare_matrix), NOT installed-base source-of-truth. Should later be sourced from equipment_installed_parts. See docs/INSTALLED_BASE_CANONICAL.md.';
