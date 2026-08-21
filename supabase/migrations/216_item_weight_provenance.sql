-- 216_item_weight_provenance.sql
--
-- Let a captured shipping weight say where it came from.
--
-- WHY. item_master.weight_kg has existed since migration 145 for freight
-- consolidation and is entirely empty — 1,000 items sampled from live data,
-- zero with a weight — because nothing in the product can write one. There is
-- no field on the item-master screen, no importer path and no endpoint that
-- accepts it. The container estimator that depends on it returns
-- recommended_mode 'none' for every real plan, and freight is apportioned by
-- line value instead of by weight.
--
-- Rather than a data-entry campaign across thousands of parts, weight is now
-- captured from documents the tenant already uploads: a quotation line that
-- states one fills the master where it is blank.
--
-- WHICH MAKES PROVENANCE LOAD-BEARING. A weight typed by a person and a weight
-- read off a supplier's PDF carry different confidence, and a wrong weight is
-- invisible — it silently mis-apportions freight on every future quote for
-- that part. So a captured weight records what it came from and which
-- document, and the ingest only ever fills a BLANK: a value already on the
-- master is authoritative and is never overwritten from a document.
--
-- weight_source values:
--   'manual'   entered by a person (reserved; no UI writes weight today)
--   'document' read from an uploaded document; weight_document_id says which
--   'derived'  computed rather than read (reserved: material x dimensions
--              from a part drawing, once that extraction is built)

alter table item_master
  add column if not exists weight_source text,
  add column if not exists weight_captured_at timestamptz,
  add column if not exists weight_document_id uuid references documents(id) on delete set null;

comment on column item_master.weight_kg is
  'Per-unit shipping weight (kg). Used by P4 freight consolidation and by the '
  'freight allocator to apportion an awarded bid. See weight_source for where '
  'the value came from.';
comment on column item_master.weight_source is
  'Where weight_kg came from: manual (a person), document (read off an upload '
  '- see weight_document_id), derived (computed, e.g. material x dimensions). '
  'Null when no weight is set.';
comment on column item_master.weight_document_id is
  'The document a weight_source=document value was read from, so a wrong '
  'weight can be traced back to the page it came from.';

-- Finding the parts still missing a weight is how coverage gets chased, and it
-- is the query the freight allocator's basis depends on.
create index if not exists item_master_missing_weight_idx
  on item_master (tenant_id)
  where weight_kg is null;
