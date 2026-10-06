-- 217_packing_list_kind.sql
--
-- Admit the packing list as an extraction kind.
--
-- WHY THIS DOCUMENT FIRST. item_master.weight_kg has been empty on every item
-- since migration 145 created it — 1,000 sampled live, zero with a weight —
-- so the freight allocator (PR #481) apportions an awarded bid by line VALUE
-- rather than by weight, and consolidatePlans returns recommended_mode 'none'
-- for every real plan.
--
-- PR #482 began filling it from quotation lines that print a weight. But a
-- quotation states a weight only sometimes; a PACKING LIST states one almost
-- always, because that is what the document is for. An importer has years of
-- them, already on disk, already describing the exact parts in the item
-- master.
--
-- GRANULARITY IS THE WHOLE REASON IT IS THIS DOCUMENT. A bill of lading gives
-- one gross weight for a container and cannot teach a per-part figure at all.
-- A packing list is per line or per carton — net and gross, usually with the
-- part number beside it. It is the only import document that can answer "what
-- does ONE of these weigh".
--
-- No new table: the DocAI pipeline routes on extraction_runs.extraction_kind,
-- and a kind is a schema on the existing adapter. Same shape as migration 184
-- (assembly_bom, part_drawing) and 188 (quote).

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'extraction_runs'::regclass
      and conname = 'extraction_runs_extraction_kind_check'
  ) then
    alter table extraction_runs drop constraint extraction_runs_extraction_kind_check;
  end if;
end $$;

alter table extraction_runs
  add constraint extraction_runs_extraction_kind_check
  check (extraction_kind in (
    'po', 'rfq', 'supplier_ack', 'invoice', 'eway_bill', 'generic',
    'assembly_bom', 'part_drawing', 'quote',
    -- New here. Per-line net/gross weights, carton counts and marks.
    'packing_list'
  ));
