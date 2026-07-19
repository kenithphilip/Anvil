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
import { callOpenRouter } from "./openrouter.js";

const norm = (s) => String(s || "").trim().toLowerCase();
const featureEnv = (feature) => (feature ? process.env["LLM_PROVIDER_" + String(feature).toUpperCase()] : null);

// P2: per-tenant provider config from tenant_settings, short-TTL cached so
// high-volume features don't add a DB read per call. `settings` may be the
// full tenant_settings row or { llm_provider, llm_provider_overrides }.
const providerOf = (settings, feature) => {
  if (!settings) return null;
  const ov = settings.llm_provider_overrides;
  const perFeature = ov && typeof ov === "object" ? ov[feature] : null;
  return { perFeature: norm(perFeature) || null, tenantDefault: norm(settings.llm_provider) || null };
};

const KNOWN_PROVIDERS = new Set(["claude", "gemini", "openrouter"]);

// Precedence: explicit > per-tenant per-feature > env per-feature >
// per-tenant default > env global > "claude". Unknown strings collapse to
// "claude" so a typo can never route somewhere unexpected.
export const resolveProvider = (feature, explicit, settings) => {
  const s = providerOf(settings, feature) || {};
  const pick = norm(explicit)
    || s.perFeature
    || norm(featureEnv(feature))
    || s.tenantDefault
    || norm(process.env.LLM_PROVIDER)
    || "claude";
  return KNOWN_PROVIDERS.has(pick) ? pick : "claude";
};

// tenantId -> { at, row } cache (per serverless instance, 60s TTL).
const _settingsCache = new Map();
const LLM_SETTINGS_TTL_MS = 60_000;
const loadLlmSettings = async (svc, tenantId) => {
  if (!svc || !tenantId) return null;
  const hit = _settingsCache.get(tenantId);
  if (hit && (Date.now() - hit.at) < LLM_SETTINGS_TTL_MS) return hit.row;
  try {
    const r = await svc.from("tenant_settings")
      .select("llm_provider, llm_provider_overrides")
      .eq("tenant_id", tenantId).maybeSingle();
    const row = r.error ? null : (r.data || null);
    _settingsCache.set(tenantId, { at: Date.now(), row });
    return row;
  } catch (_e) {
    _settingsCache.set(tenantId, { at: Date.now(), row: null });
    return null;
  }
};

export const providerConfigured = (p) =>
  p === "gemini" ? !!process.env.GEMINI_API_KEY
    : p === "openrouter" ? !!process.env.OPENROUTER_API_KEY
      : !!process.env.ANTHROPIC_API_KEY;

// First configured provider other than `p`, in a stable preference order.
// Used for the no-key fallback and (opt-in) live failover.
const PROVIDER_ORDER = ["claude", "gemini", "openrouter"];
const otherConfigured = (p) => PROVIDER_ORDER.find((q) => q !== p && providerConfigured(q)) || null;

// Retryable upstream failures worth failing over on: network (0), rate limit
// (429), and 5xx. 4xx (other than 429) are the caller's fault -> no retry.
const isRetryable = (status) => status === 0 || status === 429 || (status >= 500 && status < 600);

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

const normalizeOpenRouter = (r) => {
  const choice = r.ok ? (r.data && r.data.choices && r.data.choices[0]) || null : null;
  const msg = choice ? choice.message || null : null;
  let structured = null;
  const call = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null;
  if (call && call.function && call.function.arguments) {
    try { structured = JSON.parse(call.function.arguments); } catch (_e) { structured = null; }
  }
  return {
    ok: r.ok, status: r.status, provider: "openrouter", model: r.model, tier: r.tier,
    text: (msg && msg.content) || "",
    structured,
    toolInput: () => structured,
    raw: r.data, error: r.error,
  };
};

// Dispatch to one provider and return the normalized result.
const dispatchTo = async (p, { tools, response_schema, rest }) => {
  if (p === "gemini") {
    const gopts = { ...rest };
    if (Array.isArray(tools) && tools.length && tools[0].input_schema) {
      gopts.response_schema = toGeminiSchema(tools[0].input_schema);
    } else if (response_schema) {
      gopts.response_schema = response_schema;
    }
    return normalizeGemini(await callGemini(gopts));
  }
  if (p === "openrouter") {
    return normalizeOpenRouter(await callOpenRouter({ ...rest, tools }));
  }
  return normalizeClaude(await callAnthropic({ ...rest, tools, response_schema }));
};

export const callLLM = async ({ feature, provider, settings, tools, response_schema, ...rest }) => {
  // P2: per-tenant provider config (cached). Callers pass tenantId + svc;
  // an explicit `settings` skips the fetch.
  const tenantSettingsRow = settings || await loadLlmSettings(rest.svc, rest.tenantId);
  let p = resolveProvider(feature, provider, tenantSettingsRow);
  if (!providerConfigured(p)) {
    const alt = otherConfigured(p);
    if (alt) p = alt;
  }
  const first = await dispatchTo(p, { tools, response_schema, rest });

  // Opt-in live failover (LLM_FAILOVER=1): on a retryable upstream error, try
  // the next configured provider ONCE. Off by default -> behaviour unchanged.
  if (first.ok || process.env.LLM_FAILOVER !== "1" || !isRetryable(first.status)) return first;
  const alt = otherConfigured(p);
  if (!alt) return first;
  const second = await dispatchTo(alt, { tools, response_schema, rest });
  return second.ok ? { ...second, failed_over_from: p } : first;
};

// Exported for tests.
export const __test__ = { toGeminiSchema, normalizeClaude, normalizeGemini, normalizeOpenRouter, isRetryable, otherConfigured };
