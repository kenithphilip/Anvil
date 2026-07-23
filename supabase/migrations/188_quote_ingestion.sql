-- Quote-document ingestion.
--
-- Sellers who quote in Excel/PDF outside Anvil still produce, on every quote,
-- the exact three-way mapping the order pipeline needs:
--
--     our part code  <->  the customer's own reference  <->  the description
--
-- plus the quoted price, HSN and tax rate. Ingesting those documents seeds the
-- identity flywheel (item_customer_parts) and the price history from work the
-- sales team ALREADY does, with no process change.
--
-- DESIGN NOTE — redundancy, not a waterfall stage. Nothing in the order path
-- waits for a quote to be ingested: this is an ADDITIONAL, optional source that
-- feeds the same shared learning store as operator confirmations and PO recon.
-- Ingest none, one, or a back catalogue, in any order, more than once — the
-- pipeline behaves identically, just with better or worse coverage.
--
-- Ingested quotes are materialised into the EXISTING quotes/quote_lines tables
-- rather than a parallel store, so orders/reconcile_quotes.js — which already
-- pools every non-cancelled quote for a customer and matches PO lines across
-- ALL of them — starts verifying prices with no further code.

-- 1. New extraction kind. Mirrors migration 184's pattern: drop the check by
--    its deterministic name, re-add with the value appended.
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
    'po','rfq','supplier_ack','invoice','eway_bill','generic',
    'assembly_bom','part_drawing','quote'
  ));

comment on column extraction_runs.extraction_kind is
  'DocAI routing key. po/rfq/supplier_ack/invoice/eway_bill/generic, the '
  'mechanical-drawing kinds assembly_bom + part_drawing, and quote (the '
  'seller''s OWN outbound quotation, ingested to seed part mappings + prices).';

-- 2. Provenance for a mapping learned from an ingested quote DOCUMENT, as
--    distinct from the in-app quote_sent / quote_accepted flows.
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'item_customer_parts'
      and constraint_name = 'item_customer_parts_created_via_chk'
  ) then
    alter table item_customer_parts drop constraint item_customer_parts_created_via_chk;
  end if;
end $$;

alter table item_customer_parts
  add constraint item_customer_parts_created_via_chk
  check (
    created_via is null or created_via in (
      'manual',
      'quote_sent',
      'quote_accepted',
      'quote_doc',
      'bulk_import',
      'llm_suggest',
      'cross_customer',
      'legacy'
    )
  );

-- 3. Traceability on the quote itself: which document it came from, and how.
--    Nullable + additive, so quotes authored in-app are unaffected.
alter table quotes
  add column if not exists source_document_id uuid references documents(id) on delete set null,
  add column if not exists ingest_source text;

comment on column quotes.source_document_id is
  'When the quote was INGESTED from a PDF/Excel rather than authored in Anvil, '
  'the source document. Null for in-app quotes.';
comment on column quotes.ingest_source is
  'How the quote row was created: null = authored in Anvil, ''document'' = '
  'extracted from an uploaded quotation, ''bulk'' = back-catalogue import.';

create index if not exists quotes_source_document_idx
  on quotes (tenant_id, source_document_id)
  where source_document_id is not null;
