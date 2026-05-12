-- 120_extraction_runs_anomalies.sql
--
-- Wave 2.4 + 2.5 + 3.1 audit columns on extraction_runs:
--   - languages: jsonb summary from multi-language.js (scripts
--     seen across line descriptions, count of lines needing
--     translation).
--   - handwriting_detection / handwriting_route: jsonb from
--     handwriting.js (signal strength + suggested action).
--   - anomalies / anomalies_summary / anomalies_has_blockers:
--     jsonb + boolean from anomaly.js (cross-field accounting
--     sanity).
--
-- All best-effort. The pipeline always writes the columns; the
-- absence of one of these layers (e.g. an extraction that didn't
-- touch OCR) just leaves the column null.
--
-- Idempotent. Every column add uses IF NOT EXISTS.

alter table extraction_runs
  add column if not exists languages jsonb,
  add column if not exists handwriting_detection jsonb,
  add column if not exists handwriting_route jsonb,
  add column if not exists anomalies jsonb,
  add column if not exists anomalies_summary jsonb,
  add column if not exists anomalies_has_blockers boolean;

comment on column extraction_runs.languages is
  'Wave 2.4: { scripts_seen, lines_annotated, lines_needing_translation }';
comment on column extraction_runs.handwriting_detection is
  'Wave 2.5: { suspected, score, signals }';
comment on column extraction_runs.handwriting_route is
  'Wave 2.5: { action, provider, reason }';
comment on column extraction_runs.anomalies is
  'Wave 3.1: jsonb array of { code, severity, path, line_index?, actual, expected?, detail }';
comment on column extraction_runs.anomalies_summary is
  'Wave 3.1: { error, warn, info, total }';
comment on column extraction_runs.anomalies_has_blockers is
  'Wave 3.1: true when any anomaly has severity=error; drives the recon banner';

-- Telemetry index for "show me runs with anomaly blockers".
create index if not exists extraction_runs_anomalies_blockers_idx
  on extraction_runs (tenant_id, started_at desc)
  where anomalies_has_blockers is true;
