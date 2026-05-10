# Strategic Bet 01: Foundation-model cost compression

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 1.
> Status: research complete, ready for implementation.

## TL;DR

Replace Sonnet on the hot path with **Gemini 3 Flash + Mistral OCR 3**.
Sonnet 4.6 stays as confidence-fallback only when Gemini's
`confidence_overall < 0.85`. Goal: ~5x lower cost per SO at equal
quality.

Effort: ~6 days sequential, ~3 days parallel-2, plus ~3 days canary
calendar time. Migration `097`. Phase A (shadow) -> Phase B (25%
canary) -> Phase C (100% on new chain).

---

## 1. Research summary

### 1.1 Frontier model facts (verified May 2026)

| Model | Input $/1M | Output $/1M | Context | Notes |
|---|---:|---:|---:|---|
| Gemini 3 Flash (`gemini-3-flash-preview`) | 0.50 | 3.00 | 1M | Multimodal, structured JSON Schema, free tier, `media_resolution` knob |
| Gemini 3.1 Pro (`gemini-3.1-pro-preview`) | 2.00 | 12.00 (≤200k) | 1M | Above 200k: 4 / 18 |
| Claude Haiku 4.5 | 1.00 | 5.00 | 200k | |
| Claude Sonnet 4.6 | 3.00 | 15.00 | 1M | 90% prompt-cache discount |
| Claude Opus 4.7 | 5.00 | 25.00 | 1M | New tokenizer ~+35% on same text |
| Mistral OCR 3 | $2 / 1k pages standard, $1 / 1k pages batch | | | 79.75 OmniDocBench, 88.9% handwriting, 96.6% tables, 35+ languages |

Sources: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Gemini 3 announcement](https://blog.google/products/gemini/gemini-3-flash/),
[Mistral OCR 3](https://mistral.ai/news/mistral-ocr-3),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

### 1.2 Cost-quality Pareto for Anvil's traffic

Per 18-line PO (≈5K input, 500 output tokens):

- **Gemini 3 Flash**: ~$0.0035 (~Rs 0.30)
- **Haiku 4.5**: ~$0.007 (~Rs 0.60)
- **Sonnet 4.6**: ~$0.022 (~Rs 1.85)

Plus Mistral OCR 3 batch on the ~10% image-only PDFs adds ~Rs 0.10
amortised. Net per-SO marginal cost lands ~Rs 0.45 vs the Rs 2.40
quoted in `PRICING_STRATEGY.md` today (~5.3x reduction).

### 1.3 Competitor signal

Every serious vendor in 2026 routes across multiple models:

- [Hyperscience Hypercell Spring 2026 release](https://www.hyperscience.ai/newsroom/from-idp-to-intelligent-inference-spring-2026-release/) does "Inference Layering Optimization" across CPUs / GPUs / VLMs (Gemini 1.5 Flash + Gemini 2.5 Pro + NVIDIA Nemotron 3 + their ORCA model). Validates the multi-tier-routing pattern.
- [Conexiom](https://conexiom.com/blog/conexiom-revolutionizes-sales-order-automation-with-release-of-next-gen-ai-platform-press-release) hybridises supervised models with frontier generative AI on >1B PO lines.
- [Rossum Aurora](https://rossum.ai/blog/rossum-aurora/) ships a proprietary T-LLM for transactional documents.
- [Klippa / Doxis](https://idp-software.com/vendors/klippa/) (rebrand under SER Group, March 2026) runs an LLM + OCR pipeline.

Anvil's tiered chain matches the market shape; the bet is whether the
**cheap path can be Gemini 3 Flash + Mistral OCR 3** instead of
Sonnet, leaving Sonnet for the 10-15% of low-confidence fallbacks.

---

## 2. Recommended approach

### 2.1 New `docai_provider_order` default

```
[gemini, mistral_ocr, docling, marker, unstructured, azure_di, reducto, claude]
```

### 2.2 Model assignments

| Adapter | Role | Trigger |
|---|---|---|
| Gemini 3 Flash | hot-path extractor | always first |
| Mistral OCR 3 | OCR layer | text_layer status = image_only or low_confidence |
| Sonnet 4.6 | confidence-fallback | Gemini `confidence_overall` < 0.85 |
| Opus 4.7 | escalate | operator-triggered re-extract OR Sonnet returns < 0.7 twice |
| Haiku 4.5 | deprecated from chain | env override only |

### 2.3 Threshold change

Lift the dispatcher cutoff from 0.7 to 0.85 for Gemini 3 Flash so
Sonnet fallback fires more aggressively (Sonnet is now the safety
net, not the primary).

---

## 3. Data model + migrations

**Migration 097_gemini3_mistralocr_routing.sql** (idempotent):

```sql
-- Per-tenant Mistral OCR API key
alter table tenant_settings
  add column if not exists docai_mistral_ocr_api_key_enc bytea,
  add column if not exists docai_mistral_ocr_endpoint text,
  add column if not exists docai_mistral_ocr_batch boolean default true,
  add column if not exists docai_gemini_media_resolution text default 'high';

-- Confidence threshold for Sonnet fallback (default 0.85)
alter table tenant_settings
  add column if not exists docai_fallback_confidence numeric(3,2) default 0.85;

-- Cost-rotation: only flip tenants on the legacy default order.
update tenant_settings
  set docai_provider_order = array['gemini','mistral_ocr','docling','marker','unstructured','azure_di','reducto','claude']
  where docai_provider_order is null
     or docai_provider_order = array['gemini','docling','marker','unstructured','azure_di','reducto','claude'];

-- Eval suite metadata for cost-quality regressions
alter table eval_runs
  add column if not exists model_chain text,
  add column if not exists cost_usd_total numeric(10,4),
  add column if not exists tokens_in_total bigint,
  add column if not exists tokens_out_total bigint;
```

**New env vars** (`docs/ENV_VARS.md`):
- `GEMINI_MODEL_PREFLIGHT=gemini-3-flash-preview`
- `GEMINI_MODEL_DEFAULT=gemini-3-flash-preview`
- `GEMINI_MODEL_REASONING=gemini-3.1-pro-preview`
- `GEMINI_MEDIA_RESOLUTION=high`
- `MISTRAL_OCR_MODEL=mistral-ocr-3`
- `MISTRAL_OCR_BATCH=true`
- `COST_USD_GEMINI_3_FLASH=0.0035`
- `COST_USD_GEMINI_3_PRO=0.014`
- `COST_USD_MISTRAL_OCR_3=0.001`
- `COST_USD_CLAUDE_SONNET_46=0.022`
- `COST_USD_CLAUDE_OPUS_47=0.045`
- `DOCAI_FALLBACK_CONFIDENCE=0.85`

---

## 4. User-visible UX changes

Admin DocAI cost panel (`src/v3-app/screens/admin.tsx`):

- Recommendation banner R3 retitled: *"Gemini 3 Flash is the new free-tier extractor. Sonnet 4.6 fires only on low-confidence (< 0.85) extractions. Expected cost per SO: 5x lower than the legacy chain."*
- Settings dropdown adds Gemini model picker: `gemini-3-flash-preview` (default), `gemini-3.1-pro-preview`, `gemini-2.5-flash` (legacy compat). Anthropic dropdown adds `claude-sonnet-4-6`, `claude-opus-4-7`; removes deprecated `claude-sonnet-4-20250514`.
- New "Confidence fallback threshold" slider 0.5-0.95, default 0.85, persists to `docai_fallback_confidence`.
- Chain editor adds `mistral_ocr` row (currently only an env-var hint in cost_status R6).
- Stacked-area chart palette adds `mistral_ocr: "var(--lapis-2)"` to `COST_CHART_COLORS`.

`/api/docai/cost_status` rule changes:
- R3 reflects the new model names.
- New R7: *"Gemini 2.5 Flash is in use; Gemini 3 Flash is ~3x faster and ~30% fewer tokens at the same input price - migrate."*
- New R8: *"Confidence fallback threshold below 0.85 - low-confidence Gemini extractions are landing without Sonnet review."*

---

## 5. Technical implementation plan

### Phase 1 - Adapter migration (~2 days)

1. New `src/api/_lib/docai/mistral_ocr.js` (~280 LOC). Mirrors `gemini.js`: `isConfigured`, `extract({ url, bytes, filename, mime, settings, hints })`, returns `{ ok, raw, normalized, confidences, mode, reason }`. Uses Mistral Document AI `document_url` + `document` payload, batch flag from settings.
2. New `src/api/_lib/mistral.js` (~120 LOC). Low-level `callMistralOCR()` like the existing `gemini.js`.
3. `src/api/_lib/docai/index.js` lines 14-37: import `mistral_ocr`, add to `ADAPTERS`. Lines 97, 137-138: rewrite default `docai_provider_order` literal.
4. `src/api/_lib/gemini.js` lines 24-33: change `MODEL_BY_TIER` to `gemini-3-flash-preview` and `gemini-3.1-pro-preview`. Add `media_resolution` field, default from `process.env.GEMINI_MEDIA_RESOLUTION` or `settings.docai_gemini_media_resolution`.
5. `src/api/_lib/docai/gemini.js` lines 286-295: add `media_resolution: settings?.docai_gemini_media_resolution || "high"` to `callGemini` opts.
6. `src/api/_lib/anthropic.js` lines 72-76: bump `MODEL_BY_TIER.preflight` and `generation` to `claude-sonnet-4-6`, `reasoning` to `claude-opus-4-7`. Haiku stays available via env override.

### Phase 2 - Confidence-fallback wiring (~1 day)

7. `src/api/_lib/docai/index.js` line 200: replace `conf >= 0.7` with `conf >= (settings?.docai_fallback_confidence || 0.85)` for Gemini results.
8. `src/api/_lib/docai/model_selector.js` lines 83-114: add a Sonnet 4.6 selector branch when called with `kind=fallback_after_gemini`.

### Phase 3 - Cost telemetry (~0.5 day, parallel-safe)

9. `src/api/_lib/cost_guard.js` lines 41-49: add `mistral_ocr: 0.001`, refresh `gemini` to read `COST_USD_GEMINI_3_FLASH` first.
10. `src/api/docai/cost_status.js`: refresh model strings (line 71); rewrite R3 (lines 78-83); lift R6 mistral_ocr from info to warn when image-only PDFs landed today (lines 116-128); add R7 + R8.
11. `src/v3-app/screens/admin.tsx` lines 3773, 3805-3813: add `mistral_ocr` to `DOCAI_ADAPTERS_LIST` and `COST_CHART_COLORS`.

### Phase 4 - Migration + env (~0.5 day, parallel)

12. Add `supabase/migrations/097_gemini3_mistralocr_routing.sql`.
13. Update `docs/ENV_VARS.md`, `docs/COST_OPTIMIZED_DEPLOYMENT.md`, `docs/PRICING_STRATEGY.md` (unit-economics drops from Rs 2.40 to Rs 0.45 per 18-line PO).
14. Tests: `api-docai-mistral-ocr.test.js`, `api-docai-gemini-3.test.js`, regression in `api-docai-run-pipeline.test.js`.

### Phase 5 - Eval / regression (~1 day, parallel)

15. New eval suite fixture `corpus/eval-bet1/` (50 documents: 30 Indian + 10 Korean + 5 Japanese + 5 German). Reuse `src/api/eval/run.js` `scoreCase`.
16. Pass criteria: aggregate score >= legacy chain AND `cost_usd_total` <= 0.20x legacy.

### Rollout

- **Week 1**: shadow mode. New chain runs alongside legacy on 10% of tenants but persists only legacy result. Compare via the new eval table.
- **Week 2**: 25% canary. New chain primary for opt-in tenants; Sonnet 4.6 fallback active.
- **Week 3**: 100% on new chain for new tenants; legacy tenants stay until they opt in via the cost panel.
- **Week 4**: deprecate Gemini 2.5 Flash + Sonnet-as-primary. Migration auto-flips remaining default tenants.

---

## 6. Risks and open questions

- **Mistral OCR Korean / Japanese**. 35+ languages claimed; KR/JP accuracy on real Anvil traffic unknown until eval. Mitigation: per-tenant `docai_provider_order` override so KR-heavy tenants can keep `azure_di` ahead of `mistral_ocr` if eval shows regression.
- **Gemini 3 Flash is preview, not GA**. `gemini-3-flash-preview` is the model id today. Google may rename / reprice on GA. Mitigation: env-var indirection via `GEMINI_MODEL_DEFAULT`. One env flip at GA.
- **Confidence calibration**. Gemini's self-reported `confidence` is not perfectly correlated with downstream PO-acceptance. The 0.85 threshold is a starting point; tune per-tenant from eval results.
- **Sonnet 4.6 fallback latency**. Two-shot (Gemini fail -> Sonnet retry) doubles end-to-end on 10-15% of low-confidence calls. Mitigation: prompt-caching is wired in `callAnthropic`; ensure system prompt has `cache_control` so cache reads at $0.30/MTok dominate fallback cost.
- **Opus 4.7 tokenizer**. +35% token count on the same text means cost projections for the escalate tier are 35% higher than naive arithmetic. Bake into `COST_USD_CLAUDE_OPUS_47=0.045`.
- **Free-tier rate limits at scale**. Gemini 3 Flash free quota is generous on AI Studio but smaller on Vertex; combined PoC traffic could trigger 429s. Add an R9 rule when Gemini 429-rate exceeds 5%.

Open:
- Does `mistral_ocr` need its own `model_selector` tier or is the batch flag sufficient?
- Hard-deprecate Haiku 4.5 from the chain or keep as an env-pinnable option?
- Where does the admin "confidence fallback threshold" slider live - chain editor or new "Quality" tab?

---

## 7. Effort estimate

- Sequential days: ~6 (adapter -> wiring -> eval suite -> rollout watch).
- Parallel days with 2 engineers: ~3 (one on adapters + cost_guard + tests; one on UI + migrations + eval corpus).
- Plus ~3 days canary calendar time (low engineering load, mostly observation).

---

## 8. Sources cited

- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 3 Developer Guide](https://ai.google.dev/gemini-api/docs/gemini-3)
- [Gemini structured output docs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini media_resolution docs](https://ai.google.dev/gemini-api/docs/media-resolution)
- [Introducing Gemini 3 Flash (Google blog, Dec 17 2025)](https://blog.google/products/gemini/gemini-3-flash/)
- [Gemini 3.1 Pro pricing analysis](https://www.verdent.ai/guides/gemini-3-1-pro-pricing)
- [Mistral OCR 3 announcement](https://mistral.ai/news/mistral-ocr-3)
- [Mistral pricing](https://mistral.ai/pricing)
- [Mistral OCR 3 Technical Review (PyImageSearch)](https://pyimagesearch.com/2025/12/23/mistral-ocr-3-technical-review-sota-document-parsing-at-commodity-pricing/)
- [OmniDocBench leaderboard (CodeSOTA)](https://www.codesota.com/ocr/benchmark/omnidocbench)
- [MarkTechPost on Mistral OCR 3](https://www.marktechpost.com/2025/12/19/mistral-ai-releases-ocr-3-a-smaller-optical-character-recognition-ocr-model-for-structured-document-ai-at-scale/)
- [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Conexiom next-gen AI platform release](https://conexiom.com/blog/conexiom-revolutionizes-sales-order-automation-with-release-of-next-gen-ai-platform-press-release)
- [Rossum Aurora overview](https://rossum.ai/aurora-advanced-ai/)
- [Rossum Aurora technical details](https://rossum.ai/blog/rossum-aurora/)
- [Hyperscience Hypercell Spring 2026 release (Apr 7 2026)](https://www.hyperscience.ai/newsroom/from-idp-to-intelligent-inference-spring-2026-release/)
- [Klippa / Doxis AI.dp profile](https://idp-software.com/vendors/klippa/)
