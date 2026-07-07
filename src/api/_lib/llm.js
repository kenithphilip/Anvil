// Provider-agnostic LLM router (P1 of the app-wide LLM abstraction).
//
// Lets non-DocAI reasoning/generation features run on Claude OR Gemini
// behind ONE call with a normalized result — the same plug-and-play the
// DocAI adapter chain has, for the copilot-adjacent surfaces.
//
//   const r = await callLLM({ feature: "email_classifier", tenantId,
//                             purpose, tier, system, messages, tools });
//   r.text        -> assistant text (both providers)
//   r.structured  -> the structured object (Claude tool_use.input, or
//                    Gemini responseSchema JSON) — use for classify/score
//   r.toolInput(name) -> same, addressable by tool name (Claude)
//
// Provider selection (first hit wins):
//   1. explicit  callLLM({ provider: "gemini" })
//   2. per-feature env  LLM_PROVIDER_<FEATURE>=gemini
//   3. global env  LLM_PROVIDER=gemini
//   4. default "claude"
// If the chosen provider has no key, it falls back to the other configured
// one. Default is claude everywhere, so behavior is unchanged until a
// feature is explicitly opted onto Gemini.
//
// The firewall + PII redaction + telemetry live inside callAnthropic /
// callGemini, so routing to them preserves all of it.

import { callAnthropic } from "./anthropic.js";
import { callGemini, extractTextFromGemini, parseStructuredGemini } from "./gemini.js";

const norm = (s) => String(s || "").trim().toLowerCase();
const featureEnv = (feature) => (feature ? process.env["LLM_PROVIDER_" + String(feature).toUpperCase()] : null);

export const resolveProvider = (feature, explicit) => {
  const pick = norm(explicit) || norm(featureEnv(feature)) || norm(process.env.LLM_PROVIDER) || "claude";
  return pick === "gemini" ? "gemini" : "claude";
};

const providerConfigured = (p) =>
  (p === "gemini" ? !!process.env.GEMINI_API_KEY : !!process.env.ANTHROPIC_API_KEY);

// Anthropic tool input_schema -> Gemini responseSchema (OpenAPI subset):
// strip keys Gemini's schema validator rejects.
const toGeminiSchema = (schema) => {
  const drop = new Set(["$schema", "additionalProperties", "$id", "title"]);
  const walk = (s) => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) { if (!drop.has(k)) out[k] = walk(v); }
    return out;
  };
  return walk(schema);
};

const normalizeClaude = (r) => {
  const blocks = (r.data && r.data.content) || [];
  const toolBlocks = blocks.filter((b) => b && b.type === "tool_use");
  const textBlock = blocks.find((b) => b && b.type === "text");
  return {
    ok: r.ok, status: r.status, provider: "claude", model: r.model, tier: r.tier,
    text: textBlock ? textBlock.text : "",
    structured: toolBlocks.length ? toolBlocks[0].input : null,
    toolInput: (name) => {
      const b = name ? toolBlocks.find((t) => t.name === name) : toolBlocks[0];
      return b ? b.input : null;
    },
    raw: r.data, error: r.error,
  };
};

const normalizeGemini = (r) => {
  const structured = r.ok ? (parseStructuredGemini(r.data)?.value ?? null) : null;
  return {
    ok: r.ok, status: r.status, provider: "gemini", model: r.model, tier: r.tier,
    text: r.ok ? extractTextFromGemini(r.data) : "",
    structured,
    toolInput: () => structured,
    raw: r.data, error: r.error,
  };
};

export const callLLM = async ({ feature, provider, tools, response_schema, ...rest }) => {
  let p = resolveProvider(feature, provider);
  if (!providerConfigured(p)) {
    const other = p === "gemini" ? "claude" : "gemini";
    if (providerConfigured(other)) p = other;
  }
  if (p === "gemini") {
    const gopts = { ...rest };
    if (Array.isArray(tools) && tools.length && tools[0].input_schema) {
      // Translate the (single) structured-output tool into a responseSchema.
      gopts.response_schema = toGeminiSchema(tools[0].input_schema);
    } else if (response_schema) {
      gopts.response_schema = response_schema;
    }
    return normalizeGemini(await callGemini(gopts));
  }
  return normalizeClaude(await callAnthropic({ ...rest, tools, response_schema }));
};

// Exported for tests.
export const __test__ = { toGeminiSchema, normalizeClaude, normalizeGemini };
