-- 094_model_selector.sql
--
-- Deterministic LLM model selector (May 2026). Replaces the
-- "default to Sonnet 4 unless ANTHROPIC_MODEL_DEFAULT is set"
-- behaviour that caused three observed failure modes:
--
--   1. Sonnet on simple text-PDF POs: ~$0.022/extraction when
--      Haiku (~$0.006) would handle them just fine.
--   2. Haiku on OCR-derived noisy text: parse failures because
--      the cheap model can't distinguish OCR garbage from real
--      content.
--   3. Tenant pin to a stale model: persistent 404 with no
--      structured trace of why.
--
-- The selector is in src/api/_lib/docai/model_selector.js. It
-- runs inside claude.js + gemini.js's extract() and returns the
-- chosen model name + reason. Both columns persist here so the
-- diagnostics tab can render "we used Sonnet because the L2 OCR
-- layer fed the prompt" without re-running selection logic in
-- the browser.
--
-- Idempotent.

alter table extraction_runs
  add column if not exists selected_model text,
  add column if not exists model_selection_reason text;

comment on column extraction_runs.selected_model is
  'Phase Cost-Opt: actual LLM model the adapter ran (e.g. claude-haiku-4-5-20251001 or gemini-2.5-flash). Recorded by claude.js / gemini.js when the model selector picks the model.';
comment on column extraction_runs.model_selection_reason is
  'Phase Cost-Opt: human-readable reason the selector picked this model. Examples: tenant_pinned, escalate_quality, ocr_derived_text, default_cost_optimised, invoice_many_lines.';

create index if not exists extraction_runs_model_reason_idx
  on extraction_runs (tenant_id, model_selection_reason, finished_at desc)
  where model_selection_reason is not null;
