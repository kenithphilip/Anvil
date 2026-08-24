-- 220_sales_order_kind.sql
--
-- The SALES ORDER kind: the document an ERP produces on receiving a customer
-- purchase order. It is the third side of the Mode A/B comparison — the
-- customer's PO says what was asked for, Anvil produces what it would do, and
-- this records what a person actually did.
--
-- Anvil does not raise this document; it reads one exported from wherever the
-- customer's sales orders are actually processed. That is deliberate. The
-- earlier design pulled sales orders through the Tally bridge, and PR 0 found
-- that bridge has never carried a byte for any tenant — while every customer
-- already exports the document as a PDF. Requiring an ERP integration before a
-- customer will trust the software is a bigger ask than the thing being
-- evaluated.
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
    'assembly_bom', 'part_drawing', 'quote', 'packing_list',
    -- New here.
    'sales_order'
  ));

comment on column extraction_runs.extraction_kind is
  'Which document schema the extractor ran. sales_order = an outbound sales order / order acknowledgement read back from the ERP that produced it, for the Mode A/B three-way comparison against the customer PO and Anvil''s own proposal.';

-- extraction_jobs carries the same vocabulary (migration 219) so a long sales
-- order can be backgrounded. Left in step deliberately: a kind permitted on a
-- run but not on a job would be refused at enqueue with a confusing error.
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
        'assembly_bom', 'part_drawing', 'quote', 'packing_list', 'sales_order'
      ));
  end if;
end $$;
