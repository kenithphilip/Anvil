-- 088_extraction_runs_status_reason.sql
--
-- Phase 3.6: structured failure-reason enum for the docai pipeline.
--
-- The audit at the close of PR #83 found that extract.js maps every
-- non-error path to status='ok', even when the run produced 0 lines
-- or Claude returned classification='non_po'. The intake then stamps
-- extraction_run_id and the workspace stepper turns Extract green
-- with an empty reconciliation table. Operators see "credits burned,
-- no result, stepper green" with no signal as to why.
--
-- This migration:
--   1. Adds extraction_runs.status_reason: a categorised enum
--      surfacing what specifically happened.
--   2. Adds a partial index for diagnostics queries (open empty
--      runs, lookup by source_id).
--
-- The enum values are open-ended (text + check) so we can extend
-- the catalog without a type rebuild.
--
-- Idempotent.

alter table extraction_runs
  add column if not exists status_reason text
    check (status_reason is null or status_reason in (
      'ok',
      'low_confidence',
      'empty_lines',           -- ok-shaped but lines = 0
      'non_po',                -- classifier said this isn't a PO
      'no_adapter_configured', -- tenant has no docai adapter
      'all_adapters_skipped',  -- every adapter said "not configured"
      'image_pdf_no_text',     -- text-extraction ran on a binary PDF
      'parse_failed',          -- model returned no tool_use
      'model_refused',         -- model returned a refusal stop
      'upstream_error',        -- 5xx / network failure from provider
      'fail_unknown'
    ));

create index if not exists extraction_runs_status_reason_idx
  on extraction_runs (tenant_id, status_reason, finished_at desc)
  where status_reason is not null;

-- Convenience: a partial index for "diagnose this order's runs"
-- queries from the workspace's Pipeline Diagnostics tab.
create index if not exists extraction_runs_source_id_idx
  on extraction_runs (tenant_id, source_id, finished_at desc)
  where source_id is not null;
