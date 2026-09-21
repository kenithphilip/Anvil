-- 226_delivery_note_kind.sql
--
-- The DELIVERY NOTE kind (India: delivery challan / DC): the document that
-- accompanies goods when they leave the store.
--
-- WHY. PR #539 shipped a pre-send dispatch-readiness check — can the consignment
-- behind this invoice lawfully move: is a required e-way bill filed, is there a
-- docket number. It works and it reports `docket_missing` on EVERY invoice,
-- because nothing captures the docket. The owner's despatch register is kept in
-- Tally, where a person types the docket number and the e-way bill details
-- against each invoice, and Anvil never sees it.
--
-- Extracting the challan closes that loop, and it is the option that needs no
-- new data entry: the document already exists on every consignment. It also
-- feeds `dispatch_lines` (migration 193), whose writer has existed and been
-- tested since it was built and has never had a caller.
--
-- Chosen over the two alternatives deliberately. A workbook importer would be
-- cheaper but adds a file for somebody to maintain; rendering our own delivery
-- note would mean Anvil producing the document rather than reading the one that
-- already governs, which is a bigger change to how the store works. Reading the
-- existing document is the smallest thing that can work.
--
-- Additive and idempotent: re-running drops and recreates the same constraint.

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
    'assembly_bom', 'part_drawing', 'quote', 'packing_list', 'sales_order',
    -- New here.
    'delivery_note'
  ));

comment on column extraction_runs.extraction_kind is
  'Which document schema the extractor ran. delivery_note = the delivery challan that accompanies goods out of the store, read for the docket / LR number, the e-way bill reference and the despatched quantities per line. Feeds dispatch_lines (migration 193) and the pre-send dispatch-readiness check.';

-- extraction_jobs carries the same vocabulary (migration 219) so a long
-- multi-page challan can be backgrounded. Kept in step deliberately: a kind
-- permitted on a run but not on a job is refused at enqueue with a confusing
-- error, which is how this pair last went out of step.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'extraction_jobs'::regclass
      and conname = 'extraction_jobs_extraction_kind_check'
  ) then
    alter table extraction_jobs drop constraint extraction_jobs_extraction_kind_check;
    alter table extraction_jobs
      add constraint extraction_jobs_extraction_kind_check
      check (extraction_kind is null or extraction_kind in (
        'po', 'rfq', 'supplier_ack', 'invoice', 'eway_bill', 'generic',
        'assembly_bom', 'part_drawing', 'quote', 'packing_list', 'sales_order',
        'delivery_note'
      ));
  end if;
end $$;
