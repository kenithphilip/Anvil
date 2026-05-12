-- 124_extraction_runs_prompt_version.sql
--
-- Wave 4.5 / Improvement #20: prompt versioning + A/B split.
-- Persists the prompt version that produced each extraction so
-- the diagnostics dashboard can chart accuracy / latency / cost
-- per prompt version per adapter per customer.
--
-- Idempotent.

alter table extraction_runs
  add column if not exists prompt_version jsonb;

comment on column extraction_runs.prompt_version is
  'Wave 4.5: { name, version, source } resolved by prompt-versions.js for this run.';

-- Telemetry index for "show me runs by prompt_version".
create index if not exists extraction_runs_prompt_version_idx
  on extraction_runs (tenant_id, (prompt_version ->> 'version'), created_at desc)
  where prompt_version is not null;
