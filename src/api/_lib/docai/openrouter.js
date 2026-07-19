// OpenRouter DocAI extraction adapter (opt-in, dark).
//
// Registers OpenRouter as a pluggable extraction adapter alongside claude /
// gemini / reducto / …, so a tenant can route PO extraction to any OpenRouter
// model and adapter-learning can learn which wins (the "candidate supply"
// idea). NOT in the default provider order — it only runs when a tenant adds
// "openrouter" to docai_provider_order or picks it via the SO-workspace engine
// picker, AND OPENROUTER_API_KEY is set. Off by default.
//
// Reuses the shared extraction contract (SYSTEM_PROMPT + TOOL_DEFINITION from
// claude.js) and the callOpenRouter primitive (firewall + PII redaction +
// safeFetch, from _lib/openrouter.js), so it produces the same normalized shape
// the pipeline expects.
//
// TEXT-FIRST: OpenRouter fronts many models whose native-PDF support varies, so
// this adapter extracts from the pipeline's text/OCR layer (hints.bodyText, set
// from the L1 text layer or L2 Mistral OCR) rather than shipping raw PDF bytes.
// Image-only PDFs with no OCR text are skipped cleanly (reason: no_text_layer),
// and the dispatcher falls through to the next adapter. See
// docs/OPENROUTER_FAILOVER_NOTES.md for the compliance/data-egress gate.

import { callOpenRouter, pickOpenRouterModel } from "../openrouter.js";
import { parseSchemaAligned } from "./parse.js";
import { SYSTEM_PROMPT, TOOL_DEFINITION } from "./claude.js";

export const isConfigured = (_settings) => !!process.env.OPENROUTER_API_KEY;

const systemText = () =>
  (Array.isArray(SYSTEM_PROMPT)
    ? SYSTEM_PROMPT.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("\n")
    : String(SYSTEM_PROMPT || ""));

const clampConf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
};

export const extract = async ({ settings, hints } = {}) => {
  if (!isConfigured()) return { ok: false, reason: "no_api_key", error: "OPENROUTER_API_KEY not set", mode: "none" };
  const tenantId = settings?.tenant_id;
  if (!tenantId) return { ok: false, reason: "no_tenant", error: "tenant_id missing on settings (caller must pass it)", mode: "none" };

  const docText = typeof hints?.bodyText === "string" ? hints.bodyText.trim() : "";
  if (!docText) {
    return { ok: false, reason: "no_text_layer", error: "OpenRouter adapter is text-first; needs hints.bodyText (L1 text or L2 OCR).", mode: "none" };
  }

  const model = settings?.docai_openrouter_model || process.env.OPENROUTER_DOCAI_MODEL || pickOpenRouterModel();
  const toolName = TOOL_DEFINITION?.name || "extract_purchase_order";

  const r = await callOpenRouter({
    tenantId,
    system: systemText(),
    messages: [{ role: "user", content: "DOCUMENT:\n" + docText.slice(0, 50_000) + "\n\nCall " + toolName + " with the result." }],
    tools: [TOOL_DEFINITION],
    model,
    max_tokens: 2000,
    temperature: 0,
  });
  if (!r.ok) {
    return { ok: false, status: r.status, mode: "openrouter_document", reason: "upstream_error", error: r.error || "openrouter failed", selected_model: model, parse_method: "failed" };
  }

  // Prefer the forced tool_call arguments; fall back to message text.
  const msg = r.data && r.data.choices && r.data.choices[0] ? r.data.choices[0].message : null;
  const argStr = msg && Array.isArray(msg.tool_calls) && msg.tool_calls[0] && msg.tool_calls[0].function
    ? msg.tool_calls[0].function.arguments
    : null;
  const parsed = await parseSchemaAligned(argStr || (msg && msg.content) || "");
  const out = parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : null;
  if (!out) {
    return { ok: false, status: r.status, mode: "openrouter_document", reason: "parse_failed", error: "OpenRouter did not return parseable extraction output", raw: r.data, selected_model: model, parse_method: "failed" };
  }
  const parseMethod = parsed.parse_method || "tool_use";

  // Light normalization — mirrors claude.js's tool-output -> normalized mapping
  // (pass-through of the shared TOOL_DEFINITION shape + confidence derivation).
  if (out.classification === "non_po") {
    return {
      ok: true, mode: "openrouter_document", reason: "non_po",
      normalized: { classification: "non_po", customer: null, lines: [] },
      confidences: { overall: clampConf(out.confidence) },
      selected_model: model, parse_method: parseMethod, raw: r.data,
    };
  }
  const lines = Array.isArray(out.lines) ? out.lines : [];
  const overall = clampConf(out.confidence);
  const confidences = { overall };
  lines.forEach((_l, i) => { confidences["lines[" + i + "]"] = overall; });
  return {
    ok: true,
    mode: "openrouter_document",
    reason: lines.length === 0 ? "empty_lines" : "ok",
    normalized: { classification: out.classification || null, customer: out.customer || null, lines },
    confidences,
    selected_model: model,
    parse_method: parseMethod,
    raw: r.data,
  };
};
