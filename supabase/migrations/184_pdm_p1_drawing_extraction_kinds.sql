-- CM PDM P1a: admit mechanical-drawing extraction kinds.
--
-- The DocAI pipeline routes by extraction_runs.extraction_kind. Migration 091
-- pinned the allowed set to ('po','rfq','supplier_ack','invoice','eway_bill',
-- 'generic') via an inline column CHECK. P1 adds the first real DRAWING kinds:
--   - assembly_bom  the gun/asset assembly drawing's parts-list BOM table
--                   (the only drawing shared with the customer)
--   - part_drawing  an individual child-part drawing (supplier-only; reserved
--                   here so P3 can extract it without another migration)
-- A new kind is admitted the same way supplier_ack was: schema + prompt in the
-- two LLM adapters, plus this CHECK. No new table, no new column.
--
-- The 091 constraint is an unnamed inline column check, which Postgres names
-- deterministically <table>_<column>_check. Drop-and-re-add is the only way to
-- widen an enum-style CHECK. Guarded so re-running is a no-op.

do $$
begin
  -- Drop the existing check regardless of how it was named. Prefer the
  -- deterministic inline name; fall back to any check on the column.
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
    'po','rfq','supplier_ack','invoice','eway_bill','generic',
    'assembly_bom','part_drawing'
  ));

comment on column extraction_runs.extraction_kind is
  'DocAI routing key. po/rfq/supplier_ack/invoice/eway_bill/generic + the P1 '
  'mechanical-drawing kinds assembly_bom (customer-facing parts list) and '
  'part_drawing (supplier-only child-part detail).';
