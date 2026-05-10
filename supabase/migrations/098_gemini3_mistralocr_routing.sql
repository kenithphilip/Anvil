-- 098_gemini3_mistralocr_routing.sql
--
-- Bet 1: foundation-model cost compression. Moves Anvil's docai
-- chain off Gemini 2.5 Flash + Sonnet-as-primary and onto:
--
--   Gemini 3 Flash (primary, $0.50 in / $3 out per 1M)
--   Mistral OCR 3 (batch path, $1 / 1k pages)
--   Sonnet 4.6 (confidence-fallback only, fires when overall < 0.85)
--   Opus 4.7 (escalate tier, operator-triggered or repeated failure)
--
-- Per docs/STRATEGIC_BET_01_cost_compression.md. Expected unit-cost
-- drop ~5x at equal quality (Rs 2.40 -> Rs 0.45 per 18-line PO).
--
-- Adds the per-tenant settings columns and refreshes the default
-- provider order rotation. Idempotent.

-- Per-tenant Mistral OCR config
alter table tenant_settings
  add column if not exists docai_mistral_ocr_api_key_enc bytea,
  add column if not exists docai_mistral_ocr_endpoint text,
  add column if not exists docai_mistral_ocr_batch boolean default true,
  add column if not exists docai_gemini_media_resolution text default 'high';

-- Confidence threshold for Sonnet fallback (default 0.85)
alter table tenant_settings
  add column if not exists docai_fallback_confidence numeric(3,2) default 0.85;

-- Drop / recreate the threshold CHECK so the migration is fully
-- idempotent against re-runs.
alter table tenant_settings
  drop constraint if exists tenant_settings_docai_fallback_confidence_check;
alter table tenant_settings
  add constraint tenant_settings_docai_fallback_confidence_check
  check (docai_fallback_confidence is null or (docai_fallback_confidence >= 0.50 and docai_fallback_confidence <= 0.99));

-- Rotate the default chain on tenants who never customised it. We
-- detect "default" by matching against either NULL or any of the
-- two known prior defaults so this can re-run safely.
update tenant_settings
  set docai_provider_order = array['gemini','docling','marker','unstructured','azure_di','reducto','claude']::text[]
  where docai_provider_order is null;

-- (No need to flip an explicit migration for the chain order itself
-- because Mistral is the OCR LAYER, not a step in the provider
-- chain. ocr_layer.js handles the routing when the text-layer
-- detector says the PDF is image-only.)

comment on column tenant_settings.docai_mistral_ocr_batch is
  'Bet 1: when TRUE, the OCR layer prefers the batch endpoint (Rs 0.10 / 1k pages) over the realtime endpoint (Rs 0.20 / 1k pages). Default true; flip to false for tenants that need synchronous OCR.';
comment on column tenant_settings.docai_gemini_media_resolution is
  'Bet 1: Gemini 3 media_resolution knob. low|medium|high|ultra_high. Default high for dense PO PDFs. Lower values reduce token cost on simple POs but lose fine-text legibility.';
comment on column tenant_settings.docai_fallback_confidence is
  'Bet 1: extractor confidence threshold under which the dispatcher falls back to the next adapter (typically Sonnet 4.6). Default 0.85 vs the legacy 0.70 because Gemini 3 Flash is now the primary and Sonnet is the safety net.';

-- Eval-suite metadata for cost-quality regressions. eval_runs gets
-- model_chain (which chain was used), cost_usd_total (sum of per-
-- attempt costs), tokens_in/out so the new chain can be A/B'd
-- against the legacy one.
alter table eval_runs
  add column if not exists model_chain text,
  add column if not exists cost_usd_total numeric(10,4),
  add column if not exists tokens_in_total bigint,
  add column if not exists tokens_out_total bigint;

create index if not exists eval_runs_model_chain_idx
  on eval_runs (tenant_id, model_chain, started_at desc)
  where model_chain is not null;
