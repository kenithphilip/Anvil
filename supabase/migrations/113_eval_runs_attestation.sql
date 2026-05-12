-- 113_eval_runs_attestation.sql
--
-- Phase 1 F3 from docs/audits/2026_05_11_product_deep_dive/phases/01_p0_fixes.md.
--
-- Before this change, every eval_runs row was created from
-- caller-asserted `actual` extraction output: the caller computed
-- the result, posted both expected + actual to /api/eval/run, and
-- the server only scored the comparison. That means the dashboard's
-- "96% accuracy" number could be manufactured by a caller who
-- handed-in already-correct actuals.
--
-- Adds:
--
--   - attestation_hmac: HMAC-SHA-256 over a canonical receipt of
--     (suite, run_id, passed, failed, total_score,
--     prompt_version, model_version, pipeline_version,
--     created_at, case_id_hashes). The receipt and the secret
--     together prove the row was produced by Anvil's server, not
--     by the caller. Verifier in src/api/_lib/eval-attestation.js.
--
--   - prompt_version / model_version / pipeline_version: the
--     versions in effect when the eval ran. Together with the
--     HMAC, the receipt is auditable end-to-end.
--
-- Existing rows are not signed retroactively; their attestation
-- column stays null and the dashboard renders "unverified" for
-- the legacy window.

alter table eval_runs
  add column if not exists attestation_hmac text,
  add column if not exists prompt_version text,
  add column if not exists model_version text,
  add column if not exists pipeline_version text,
  add column if not exists server_verified boolean not null default false;

comment on column eval_runs.attestation_hmac is
  'HMAC-SHA-256 of the canonical receipt for this run. Null on rows created before migration 113 or on caller-asserted runs that did not go through runExtractionPipeline server-side.';

comment on column eval_runs.server_verified is
  'TRUE when the eval invoked runExtractionPipeline server-side and signed the row attestation_hmac. FALSE for legacy caller-asserted runs.';

create index if not exists eval_runs_verified_idx
  on eval_runs (server_verified, created_at desc);
