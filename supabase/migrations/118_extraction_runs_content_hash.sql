-- 118_extraction_runs_content_hash.sql
--
-- Wave 1.3 / Improvement #12: content-hash dedupe at the upstream
-- call site.
--
-- Background. The L1 text layer and L2 OCR layer already key off a
-- SHA-256 of the input bytes (extraction_text_layer.content_hash,
-- extraction_ocr_layer.content_hash) so re-uploading the same PDF
-- skips the deterministic extractors. The L4 LLM stage still runs
-- every time because extraction_runs does not carry the hash, so
-- there is no way to short-circuit the run before the adapter chain
-- fires. Concretely: an operator who uploads the same Hyundai PO
-- twice within a few minutes pays for the LLM call twice; a batch
-- importer that retries a failed cron iteration burns the LLM
-- budget on every retry.
--
-- This migration adds the hash column to extraction_runs and an
-- index on (tenant_id, customer_id, content_hash, created_at desc)
-- so the dedupe lookup is a single index scan. The dispatcher hits
-- it BEFORE inserting the new run row, copies the prior
-- normalized_extract + field_confidences + status across, marks
-- status_reason = 'dedupe_hit', and records a
-- docai_extract_deduped event so the cost meter and audit can
-- distinguish a fresh extraction from a replay.
--
-- Scope of the dedupe gate.
--   - Same tenant_id AND content_hash.
--   - Same customer_id when one is known (different customer means
--     different field_overrides and template; we cannot reuse).
--   - Same extraction_kind (a PO run and an invoice run on the same
--     bytes produce different normalized shapes).
--   - Within docai_content_dedupe_minutes (default 30, tenant-
--     overridable via tenant_settings).
--   - status='ok' only. A failed prior run should not poison the
--     next retry.
--
-- Idempotent: column add uses IF NOT EXISTS; index uses IF NOT
-- EXISTS. Safe to re-run.

alter table extraction_runs
  add column if not exists content_hash text;

comment on column extraction_runs.content_hash is
  'sha256 of input bytes; used by the upstream dedupe gate to short-circuit a re-upload within the dedupe window';

-- Lookup index: dedupe gate scans for the most-recent successful
-- run sharing the same hash + customer scope. Partial index so we
-- only carry rows that can actually serve as a dedupe source (status
-- ok, hash present). nulls last on customer_id so a run created
-- without a customer can match other no-customer runs.
create index if not exists extraction_runs_dedupe_lookup
  on extraction_runs (tenant_id, content_hash, customer_id, extraction_kind, created_at desc)
  where status = 'ok' and content_hash is not null;

-- Extend the status_reason CHECK to include the new 'dedupe_hit'
-- value. 088_extraction_runs_status_reason.sql declared the column
-- with an inline CHECK; 092_pipeline_audit_fixes.sql rebuilt it to
-- add 'non_ack'. We rebuild again to add the dedupe outcome.
alter table extraction_runs
  drop constraint if exists extraction_runs_status_reason_check;
alter table extraction_runs
  add constraint extraction_runs_status_reason_check
  check (status_reason is null or status_reason in (
    'ok',
    'low_confidence',
    'empty_lines',
    'non_po',
    'non_ack',
    'no_adapter_configured',
    'all_adapters_skipped',
    'image_pdf_no_text',
    'parse_failed',
    'model_refused',
    'upstream_error',
    'dedupe_hit',           -- Wave 1.3: content_hash matched a recent ok run
    'fail_unknown'
  ));

-- Companion index for the "show me dedupe hits last week" telemetry
-- query: every run carrying status_reason='dedupe_hit'. Already
-- covered by the (tenant, status_reason, created_at) index that
-- 088_extraction_runs_status_reason.sql added; no new index needed.
