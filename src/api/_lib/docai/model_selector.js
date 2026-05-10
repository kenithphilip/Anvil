// Deterministic LLM model selector for the docai pipeline.
//
// Replaces the "default to Sonnet unless overridden" behaviour
// that caused three observed failure modes:
//
//   1. Sonnet on simple text-PDF POs (~4x more expensive than
//      Haiku, no quality gain).
//   2. Haiku on OCR-derived noisy text (parse failures because
//      the cheap model can't distinguish OCR garbage).
//   3. Tenant pin to a stale model name (404 with no trace).
//
// Rules are deterministic + auditable. Each rule emits a single
// `reason` string that's persisted on extraction_runs.
// model_selection_reason so the operator can answer "why did
// this run cost $0.022 instead of $0.006?" without reading code.
//
// Selection priority (highest first):
//
//   1. Tenant pin (`docai_anthropic_model` / `docai_gemini_model`)
//      always wins. Lets the operator force a specific model for
//      compliance / reproducibility.
//   2. Caller `escalate` flag (set on retries after parse_failed,
//      model_refused, or operator-triggered re-extract).
//   3. Document context rules:
//      - kind=invoice with >= 20 lines: bump to generation tier
//      - L2 OCR layer fed bodyText: bump to generation tier
//        (OCR-derived text is noisier; cheap model fails more)
//      - text_layer.char_count > 30K: bump to generation tier
//      - kind=supplier_ack | eway_bill: stay on preflight tier
//        (short, structured docs work fine on cheap models)
//   4. Default: preflight tier (cheapest model that handles a
//      clean PO).
//
// The tiers map to actual model names via the existing
// MODEL_BY_TIER constants on each provider's client module so
// a name change (e.g. Haiku 4.5 -> 5) only touches one file.

import { MODEL_BY_TIER as CLAUDE_TIERS } from "../anthropic.js";
import { MODEL_BY_TIER as GEMINI_TIERS } from "../gemini.js";

// Thresholds. Tunable via env so an operator can shift the
// curve without a code change. Defaults chosen for typical
// Indian B2B PO traffic (5K input + 500 output tokens).
const LONG_DOC_CHAR_THRESHOLD = Number(
  process.env.MODEL_SELECTOR_LONG_DOC_CHARS || 30_000
);
const VERY_LONG_DOC_CHAR_THRESHOLD = Number(
  process.env.MODEL_SELECTOR_VERY_LONG_DOC_CHARS || 100_000
);
const HEAVY_INVOICE_LINE_THRESHOLD = Number(
  process.env.MODEL_SELECTOR_HEAVY_INVOICE_LINES || 20
);

// Compute a coarse "lineCount" hint when the caller didn't pass
// one explicitly. Useful when a template fills the customer
// header but lines are still LLM-driven.
const lineCountFromCtx = (ctx) => {
  if (Number.isFinite(Number(ctx?.lineCount))) return Number(ctx.lineCount);
  if (Array.isArray(ctx?.knownFields?.lines)) return ctx.knownFields.lines.length;
  return 0;
};

const ocrFedThePrompt = (ctx) => {
  const s = ctx?.ocrLayer?.status;
  return s === "ok" || s === "partial";
};

const charCount = (ctx) => Number(ctx?.textLayer?.char_count || 0);

// Public: pick a Claude model + tier + reason for the given
// extraction context. Pure function; no I/O.
//
//   ctx = {
//     kind:              'po' | 'rfq' | 'supplier_ack' | 'invoice' | 'eway_bill' | 'generic',
//     textLayer:         { status, char_count } | null  (Phase A L1 cache)
//     ocrLayer:          { status, char_count } | null  (Phase B L2 cache)
//     lineCount:         number   how many line items the input has (best-effort)
//     knownFields:       object   from Phase D template; used as a lineCount fallback
//     escalate:          boolean  caller wants a quality bump
//     settings:          tenant_settings row (for docai_anthropic_model pin)
//   }
//   returns { model, tier, reason }
export const selectClaudeModel = (ctx = {}) => {
  // 1. Tenant pin.
  const pin = ctx.settings?.docai_anthropic_model;
  if (pin && typeof pin === "string" && pin.trim()) {
    return { model: pin.trim(), tier: "tenant_pinned", reason: "tenant_pinned" };
  }
  // 2. Escalate.
  if (ctx.escalate) {
    return { model: CLAUDE_TIERS.generation, tier: "generation", reason: "escalate_quality" };
  }
  // 3a. Heavy invoices need accuracy on many lines.
  if (ctx.kind === "invoice" && lineCountFromCtx(ctx) >= HEAVY_INVOICE_LINE_THRESHOLD) {
    return { model: CLAUDE_TIERS.generation, tier: "generation", reason: "invoice_many_lines" };
  }
  // 3b. OCR-derived text is noisier; cheap models parse-fail.
  if (ocrFedThePrompt(ctx)) {
    return { model: CLAUDE_TIERS.generation, tier: "generation", reason: "ocr_derived_text" };
  }
  // 3c. Long documents need better reasoning context.
  if (charCount(ctx) > LONG_DOC_CHAR_THRESHOLD) {
    return { model: CLAUDE_TIERS.generation, tier: "generation", reason: "long_document" };
  }
  // 3d. Short structured kinds: preflight tier is fine.
  if (ctx.kind === "supplier_ack") {
    return { model: CLAUDE_TIERS.preflight, tier: "preflight", reason: "supplier_ack_short" };
  }
  if (ctx.kind === "eway_bill") {
    return { model: CLAUDE_TIERS.preflight, tier: "preflight", reason: "eway_bill_structured" };
  }
  // 4. Default cheapest.
  return { model: CLAUDE_TIERS.preflight, tier: "preflight", reason: "default_cost_optimised" };
};

// Public: pick a Gemini model + tier + reason. Same rule shape
// as Claude but Gemini Flash covers more cases on the free tier
// because it's a multimodal-strong cheap model; Pro only on
// genuine quality-needing signals.
export const selectGeminiModel = (ctx = {}) => {
  const pin = ctx.settings?.docai_gemini_model;
  if (pin && typeof pin === "string" && pin.trim()) {
    return { model: pin.trim(), tier: "tenant_pinned", reason: "tenant_pinned" };
  }
  if (ctx.escalate) {
    return { model: GEMINI_TIERS.reasoning, tier: "reasoning", reason: "escalate_quality" };
  }
  if (ctx.kind === "invoice" && lineCountFromCtx(ctx) >= HEAVY_INVOICE_LINE_THRESHOLD) {
    return { model: GEMINI_TIERS.reasoning, tier: "reasoning", reason: "invoice_many_lines" };
  }
  if (ocrFedThePrompt(ctx)) {
    return { model: GEMINI_TIERS.reasoning, tier: "reasoning", reason: "ocr_derived_text" };
  }
  if (charCount(ctx) > VERY_LONG_DOC_CHAR_THRESHOLD) {
    return { model: GEMINI_TIERS.reasoning, tier: "reasoning", reason: "very_long_document" };
  }
  return { model: GEMINI_TIERS.preflight, tier: "preflight", reason: "default_cost_optimised" };
};

// Provider-agnostic dispatcher used by the cost-status panel +
// the cli /api/docai/model_pick endpoint (if needed). The caller
// passes the provider it cares about.
export const selectModelForProvider = (provider, ctx) => {
  if (provider === "claude") return selectClaudeModel(ctx);
  if (provider === "gemini") return selectGeminiModel(ctx);
  return { model: null, tier: null, reason: "unknown_provider" };
};

export const __consts__ = {
  LONG_DOC_CHAR_THRESHOLD,
  VERY_LONG_DOC_CHAR_THRESHOLD,
  HEAVY_INVOICE_LINE_THRESHOLD,
};
