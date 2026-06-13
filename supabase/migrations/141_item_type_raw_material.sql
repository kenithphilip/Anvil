-- 141_item_type_raw_material.sql
-- Forecasting-driven procurement P2 (BOM-explode demand).
--
-- Raw materials need to be first-class planning items so the weekly
-- planner can carry BOM-exploded, probability-weighted finished-good
-- demand down to the steel / casting / electronics they consume and
-- emit procurement plans for them. The item_type CHECK (migration 085)
-- didn't include a raw-material class, so item_master rows couldn't be
-- typed as such. Extend the allowed set additively.
--
-- Idempotent: drop the auto-named column check and re-add with the
-- expanded value list. Existing rows are unaffected (RAW_MATERIAL is
-- purely additive; nulls and prior values still validate).

alter table item_master drop constraint if exists item_master_item_type_check;
alter table item_master
  add constraint item_master_item_type_check
  check (item_type is null or item_type in
    ('GUN', 'ATD', 'TIMER', 'GUN_COMPONENT', 'SPARE', 'CONSUMABLE', 'RAW_MATERIAL', 'OTHER'));

comment on column item_master.item_type is
  'Planning class: GUN/ATD/TIMER/GUN_COMPONENT/SPARE/CONSUMABLE/RAW_MATERIAL/OTHER. RAW_MATERIAL (P2) receives BOM-exploded demand from finished goods.';
