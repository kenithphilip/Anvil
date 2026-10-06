-- 219_extraction_jobs_kind.sql
--
-- What KIND of document the background worker is extracting.
--
-- extraction_jobs has carried no kind since it was created in 117, so the
-- worker had nothing to tell the adapter and the adapter fell back to its
-- default: the purchase-order schema. That was invisible while only purchase
-- orders could be queued — the enqueue handler requires an order_id and both
-- callers are PO flows — but it made a guess load-bearing. PR #492 had to
-- infer the kind from order_id, reasoning that this worker merges into
-- orders.result.salesOrder and so the document must be a PO. That inference is
-- true today and silently wrong the moment anything else enqueues.
--
-- With the column the worker states the kind instead of deducing it, and a
-- document queued as a quotation is read with the quotation schema rather than
-- being asked for a po_number it does not have.
--
-- The permitted values are exactly extraction_runs' list as of 217, because a
-- job's kind ends up on the run it produces and two lists that can drift are
-- two lists that will. Nullable with no default: an existing row predates the
-- column and its kind is genuinely unknown, which is not the same as 'po'.
-- Readers treat null as 'po' because that is what those rows actually were,
-- and they say so where they do it.

alter table extraction_jobs
  add column if not exists extraction_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'extraction_jobs'::regclass
      and conname = 'extraction_jobs_extraction_kind_check'
  ) then
    alter table extraction_jobs
      add constraint extraction_jobs_extraction_kind_check
      check (extraction_kind is null or extraction_kind in (
        'po', 'rfq', 'supplier_ack', 'invoice', 'eway_bill', 'generic',
        'assembly_bom', 'part_drawing', 'quote', 'packing_list'
      ));
  end if;
end $$;

comment on column extraction_jobs.extraction_kind is
  'Document kind for the background extraction, mirroring extraction_runs.extraction_kind. Null on rows created before this column: read as po, which is what they were, since only the PO flows could enqueue.';

-- The worker picks jobs by (status, lease_until) and does not filter on kind,
-- so no new index is needed. This one supports the per-kind reporting the
-- extraction metrics do (counts and defect rates by kind), which otherwise
-- sequentially scans a table that grows one row per large document.
create index if not exists extraction_jobs_tenant_kind_idx
  on extraction_jobs (tenant_id, extraction_kind, created_at desc);
