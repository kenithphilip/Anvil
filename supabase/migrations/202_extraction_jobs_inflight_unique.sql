-- 202_extraction_jobs_inflight_unique.sql
--
-- Atomic in-flight dedup for background PO extraction. The POST
-- (/api/orders/extraction_jobs) de-duped with a SELECT-then-INSERT, so two
-- near-simultaneous "Extract" clicks both saw no in-flight row and both
-- inserted — double-processing the same order (billable DocAI) and racing the
-- cron worker. A partial UNIQUE index makes at most ONE non-terminal job exist
-- per (tenant, order); the second insert fails with 23505 and the handler
-- returns the existing job (deduped) instead.
--
-- Terminal jobs (completed / failed / cancelled) are excluded, so re-extracting
-- an order after a previous run finished still works. Applied manually.
--
-- NOTE: if any duplicate in-flight jobs already exist, this CREATE will fail;
-- resolve them first (e.g. mark all-but-latest 'cancelled') then re-run.

create unique index if not exists extraction_jobs_one_inflight_per_order
  on extraction_jobs (tenant_id, order_id)
  where status in ('queued', 'profiling', 'chunking', 'extracting', 'merging');
