-- 119_extraction_runs_cost_summary.sql
--
-- Wave 1.4 / Improvement #18: per-extraction cost cap. The
-- run-cost accumulator in src/api/_lib/docai/run-cost.js threads
-- a budget through the dispatch chain (chunkedExtract ->
-- dispatchExtract -> per-adapter loop) so a single extraction
-- cannot burn unbounded LLM credits. The accumulator's final
-- summary is persisted here so the diagnostics tab can chart
-- per-run cost and the audit trail records exactly which adapter
-- calls consumed budget before the cap fired.
--
-- Shape of cost_summary:
--   {
--     "cap_usd":        1.0,
--     "total_usd":      0.087,
--     "breached":       false,
--     "call_count":     3,
--     "skipped_count":  0,
--     "calls":          [{ "adapter": "gemini", "costUsd": 0.0035, "at": "2026-05-13T..." }, ...],
--     "skipped":        [{ "adapter": "claude", "reason": "over_run_budget", "at": "..." }]
--   }
--
-- Distinct from docai_daily_usage:
--   docai_daily_usage           = per-day per-adapter ledger
--                                 (cost_guard.recordCall fills it)
--   extraction_runs.cost_summary = per-run breakdown of which
--                                 adapter calls fired and at what
--                                 estimated price.
--
-- Idempotent: column add uses IF NOT EXISTS.

alter table extraction_runs
  add column if not exists cost_summary jsonb;

comment on column extraction_runs.cost_summary is
  'Wave 1.4: per-run cost ledger { cap_usd, total_usd, breached, calls[], skipped[] }';

-- Optional partial index for the "show me runs that hit the cap"
-- diagnostics query. We index on the jsonb `breached` boolean.
create index if not exists extraction_runs_cost_breached_idx
  on extraction_runs (tenant_id, started_at desc)
  where (cost_summary ->> 'breached')::boolean is true;
