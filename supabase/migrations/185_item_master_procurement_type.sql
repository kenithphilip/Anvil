-- PDM raw-material determination (Slice D): an explicit MAKE / BUY / RAW_MATERIAL
-- flag on item_master.
--
-- Until now make-vs-buy was implicit — a part was "made" only if someone had
-- authored a raw-material recipe for it. That is fragile: the drawing-extraction
-- + inference layer could give a BOUGHT-OUT part a recipe and the weekly planner
-- would then forecast raw material for a part we purchase whole. This column
-- makes make/buy first-class so the demand explosion can DEFENSIVELY skip the
-- recipe-cascade for `buy` parts (see explodePipelineThroughBom's buyParts).
--
--   make          machined / fabricated in-house -> explodes into raw material
--   buy           bought-out / purchased whole   -> procured at part level; the
--                 explosion never cascades into its children
--   raw_material  is itself a raw material (a leaf input)
--   null          unknown (treated as make by the planner's existing behaviour,
--                 i.e. it still explodes — the guard only stops explicit `buy`)

alter table item_master
  add column if not exists procurement_type text
    check (procurement_type is null or procurement_type in ('make', 'buy', 'raw_material'));

comment on column item_master.procurement_type is
  'Make/buy classification. make -> BOM-explodes into raw material; buy -> '
  'procured at part level (explosion stops here); raw_material -> a leaf input. '
  'Set by the drawing raw-material determination layer + manufacturing review.';

-- Safe backfill: an item already typed RAW_MATERIAL is, by definition, raw
-- material. Leaves everything else null (the planner keeps exploding null/make;
-- only explicit `buy` is guarded).
update item_master
   set procurement_type = 'raw_material'
 where procurement_type is null
   and item_type = 'RAW_MATERIAL';
