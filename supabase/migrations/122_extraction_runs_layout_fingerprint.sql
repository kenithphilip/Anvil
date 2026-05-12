-- 122_extraction_runs_layout_fingerprint.sql
--
-- Wave 3.5 / Improvement #21: layout-fingerprint dedupe.
-- Adds the fingerprint hash + back-pointer columns to
-- extraction_runs so the dispatcher can find a prior run with
-- the same layout (header tokens, page count, body-size bucket)
-- and bias the adapter chain toward whichever adapter won then.
--
-- Distinct from content_hash (Wave 1.3):
--   - content_hash matches an IDENTICAL re-upload (literal byte
--     equality after sha256).
--   - layout_fingerprint matches a SIMILAR document from the
--     same customer where content (PO number, items) differs
--     but the LAYOUT (headers, columns, sizing) is the same.
--
-- Idempotent.

alter table extraction_runs
  add column if not exists layout_fingerprint text,
  add column if not exists layout_fingerprint_match uuid references extraction_runs(id) on delete set null;

comment on column extraction_runs.layout_fingerprint is
  'Wave 3.5: sha256 over [first 20 distinct header tokens, page_count, size_kb_bucket].';
comment on column extraction_runs.layout_fingerprint_match is
  'Wave 3.5: prior extraction_runs.id whose layout_fingerprint matched; null when no match.';

-- Lookup index for the dispatcher's fingerprint query.
create index if not exists extraction_runs_layout_fingerprint_lookup
  on extraction_runs (tenant_id, layout_fingerprint, customer_id, started_at desc)
  where status = 'ok' and layout_fingerprint is not null;
