// OpenRouter adapter (spike) — a third LLM provider behind llm.js.
//
// OpenRouter (https://openrouter.ai) is an OpenAI-compatible gateway that
// fronts many models with automatic provider fallback. This adapter lets a
// non-DocAI reasoning/generation feature run on it, and lets callLLM fail over
// to it when the primary provider (Anthropic/Gemini) returns a retryable error.
//
// SAFETY / SCOPE (see docs/OPENROUTER_FAILOVER_NOTES.md):
//   - Inert unless OPENROUTER_API_KEY is set AND a caller/tenant/env selects it,
//     so default behaviour is unchanged.
//   - This is the TEXT path (llm.js), not the DocAI document path: PDF/image
//     blocks are NOT sent to OpenRouter here (its models handle native PDF
//     variably; that is a separate, later evaluation). Blocks are summarised.
//   - The injection firewall + PII redaction live in Anvil's call layer, not
//     the provider, so this adapter re-applies BOTH — routing customer text
//     through a new subprocessor must not drop them.
//   - COMPLIANCE GATE: routing real tenant data through OpenRouter (a new
//     subprocessor that itself proxies to sub-providers) is a data-egress /
//     vendor-security-review question that must be answered before enabling it
//     for any real tenant. Keep it off in production until then.

import { safeFetch } from "./safe-fetch.js";
import { applyFirewall, redactMessages } from "./anthropic.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const isOpenRouterConfigured = () => !!process.env.OPENROUTER_API_KEY;

// The model slug (OpenRouter uses "<author>/<slug>" ids). Explicit override
// wins; else OPENROUTER_MODEL env; else a sensible default.
export const pickOpenRouterModel = (override) =>
  override || process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";

// applyFirewall returns a string (text system) or an array of blocks (cached
// system). OpenRouter's chat API wants a plain string system message.
const firewalledSystemText = (system, bypass) => {
  const fw = bypass ? system : applyFirewall(system);
  if (fw == null) return null;
  if (Array.isArray(fw)) return fw.map((b) => (b && b.text) || "").filter(Boolean).join("\n\n");
  return String(fw);
};

// Flatten Anthropic-style content (string | blocks[]) to text. The text router
// never carries PDF/image blocks; if one appears we summarise rather than ship
// raw bytes to OpenRouter.
export const blocksToText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((b) => {
      if (!b) return "";
      if (b.type === "text") return b.text || "";
      if (b.type === "document") return "[document omitted on the OpenRouter text path]";
      if (b.type === "image") return "[image omitted on the OpenRouter text path]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

// Anthropic tools -> OpenAI "function" tools.
export const toOpenAiTools = (tools) =>
  (Array.isArray(tools) ? tools : []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object" } },
  }));

// Returns { ok, status, data, model, tier, error } — the same shape as
// callAnthropic/callGemini so llm.js can normalise it uniformly.
export const callOpenRouter = async (opts = {}) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, status: 500, error: "OPENROUTER_API_KEY not set", tier: "openrouter" };
  if (!Array.isArray(opts.messages)) return { ok: false, status: 400, error: "messages array required", tier: "openrouter" };

  const model = pickOpenRouterModel(opts.model);
  const systemText = firewalledSystemText(opts.system, !!opts.bypassFirewall);
  const redacted = redactMessages(opts.messages, opts.redactionRules);

  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const m of redacted) {
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: blocksToText(m.content),
    });
  }

  const body = {
    model,
    messages,
    max_tokens: Number(opts.max_tokens) || 2000,
    temperature: opts.temperature == null ? 0 : Number(opts.temperature),
  };
  const tools = toOpenAiTools(opts.tools);
  if (tools.length) {
    body.tools = tools;
    // Force the (single) structured-output function so callers that pass a
    // tool get a tool_call back, mirroring Anthropic's tool_choice.
    body.tool_choice = { type: "function", function: { name: tools[0].function.name } };
  }

  const headers = {
    "content-type": "application/json",
    "authorization": "Bearer " + apiKey,
    // OpenRouter attribution headers (optional, recommended).
    "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://anvil.app",
    "X-Title": "Anvil",
  };

  let resp;
  try {
    resp = await safeFetch(OPENROUTER_URL, {
      method: "POST", headers, body: JSON.stringify(body), timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return { ok: false, status: 0, error: "Network error: " + (err?.message || String(err)), model, tier: "openrouter" };
  }
  let data = null;
  try { data = await resp.json(); } catch (_e) { data = null; }
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: data?.error?.message || ("OpenRouter HTTP " + resp.status), data, model, tier: "openrouter" };
  }
  return { ok: true, status: resp.status, data, model, tier: "openrouter" };
};
