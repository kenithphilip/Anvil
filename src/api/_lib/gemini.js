// Shared Gemini call helper.
//
// Mirrors callAnthropic() in shape: every internal caller goes
// through this helper instead of writing raw fetch calls. We
// reuse the prompt-injection firewall + PII redaction patterns
// from anthropic.js so the two providers carry the same trust
// boundary. The Gemini API (https://ai.google.dev/) speaks JSON
// Schema for structured output, so the docai/gemini.js adapter
// can request the same shape claude.js asks for via tool-use.
//
// Why Gemini for cost-optimised PoC: the free tier is generous
// (1500 RPD, 1M TPM, no card required), so PoC traffic of
// 5-50 extractions a day stays at $0/month. Pricing after free
// tier: $0.075/M input + $0.30/M output (Flash), ~10x cheaper
// than Claude Haiku.

import { safeFetch } from "./safe-fetch.js";
import { applyFirewall, redactMessages } from "./anthropic.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bet 1 (May 2026): default Gemini bumped to 3 Flash. The 2.5
// family is still env-pinnable for back-compat. Pricing per
// https://ai.google.dev/gemini-api/docs/pricing :
//   Gemini 3 Flash: $0.50 in / $3 out per 1M, 1M-token context,
//                   native multimodal, structured outputs via
//                   JSON Schema, media_resolution knob.
//   Gemini 3.1 Pro: $2 in / $12 out below 200k; $4 / $18 above.
// Per https://blog.google/products/gemini/gemini-3-flash/ :
//   3x throughput vs 2.5 Pro, ~30% fewer tokens at the same input
//   price, native PDF/image input, ranks 78% SWE-bench / 90.4%
//   GPQA Diamond / 81.2% MMMU Pro.
export const MODEL_BY_TIER = {
  preflight:  process.env.GEMINI_MODEL_PREFLIGHT  || "gemini-3-flash-preview",
  generation: process.env.GEMINI_MODEL_DEFAULT    || "gemini-3-flash-preview",
  reasoning:  process.env.GEMINI_MODEL_REASONING  || "gemini-3.1-pro-preview",
};

export const pickGeminiModel = ({ tier, override }) => {
  if (override) return { model: override, tier: "override" };
  if (tier && MODEL_BY_TIER[tier]) return { model: MODEL_BY_TIER[tier], tier };
  return { model: MODEL_BY_TIER.generation, tier: "generation" };
};

// Convert the canonical { role, content: [{type:'text'|'document'|'image'|...}] }
// shape we already use for Anthropic into Gemini's `contents` shape:
//
//   contents: [{ role: 'user'|'model', parts: [{ text }, { inlineData }, ...] }]
//
// Gemini doesn't accept `system` at message level; it goes in
// `systemInstruction`. For PDFs and images we use inlineData with
// the matching mime_type.
const mapPartFromAnthropic = (block) => {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return { text: block.text || "" };
  if (block.type === "document") {
    return { inlineData: { mimeType: block.source?.media_type || "application/pdf", data: block.source?.data || "" } };
  }
  if (block.type === "image") {
    return { inlineData: { mimeType: block.source?.media_type || "image/png", data: block.source?.data || "" } };
  }
  return null;
};

const mapMessages = (messages) => {
  return (messages || []).map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
    const parts = content.map(mapPartFromAnthropic).filter(Boolean);
    return { role, parts };
  });
};

const mapSystem = (system) => {
  if (!system) return null;
  const blocks = Array.isArray(system) ? system : [{ type: "text", text: String(system) }];
  const parts = blocks.map(mapPartFromAnthropic).filter(Boolean);
  if (!parts.length) return null;
  return { parts };
};

// callGemini: same general signature as callAnthropic. Returns
//   { ok, status, data, model, tier, error }
//
// Inputs:
//   - tenantId           required for telemetry
//   - apiKey             encrypted-decrypted Gemini API key (caller
//                        passes; we don't reach into tenant_settings here)
//   - messages           Anthropic-shaped { role, content: [...blocks] }
//   - system             Anthropic-shaped (string or array of text blocks)
//   - model              optional explicit model id
//   - tier               'preflight' | 'generation' | 'reasoning'
//   - max_tokens         maps to generationConfig.maxOutputTokens
//   - temperature        maps to generationConfig.temperature
//   - response_schema    JSON Schema for structured output (Gemini's
//                        equivalent of Anthropic tool_use). When set we
//                        force responseMimeType=application/json.
//   - response_mime_type override responseMimeType (defaults to text/plain
//                        when no schema supplied, application/json otherwise)
export const callGemini = async ({
  tenantId,
  apiKey,
  messages,
  system,
  model: modelOverride,
  tier,
  max_tokens = 2000,
  temperature = 0,
  response_schema,
  response_mime_type,
  redactionRules,
  // Bet 1: Gemini 3 media_resolution knob. low=280, medium=560,
  // high=1120, ultra_high tokens per image. Default high for dense
  // PO PDFs; lower values reduce token cost on simple POs but lose
  // fine-text legibility.
  media_resolution,
}) => {
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY missing", status: 0 };
  }
  const { model } = pickGeminiModel({ tier, override: modelOverride });

  const firewalledSystem = applyFirewall(system);
  const redactedMessages = redactMessages(messages, redactionRules);

  const body = {
    contents: mapMessages(redactedMessages),
    generationConfig: {
      maxOutputTokens: max_tokens,
      temperature,
    },
  };
  const systemInstruction = mapSystem(firewalledSystem);
  if (systemInstruction) body.systemInstruction = systemInstruction;

  if (response_schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = response_schema;
  } else if (response_mime_type) {
    body.generationConfig.responseMimeType = response_mime_type;
  }

  // Bet 1: Gemini 3 media_resolution knob. Defaults inflate token
  // count vs 2.5 Flash because 3 Flash treats every image at high
  // resolution unless told otherwise; we pin to the env default
  // ("high") to stay in the same cost band as 2.5 was.
  const resolvedMediaRes = media_resolution
    || process.env.GEMINI_MEDIA_RESOLUTION
    || "high";
  if (resolvedMediaRes && /3-/.test(model)) {
    body.generationConfig.mediaResolution = resolvedMediaRes;
  }

  const url = GEMINI_BASE + "/" + encodeURIComponent(model) + ":generateContent";
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp;
    try {
      resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body), timeoutMs: 60_000 });
    } catch (err) {
      lastErr = err;
      if (attempt < 3) { await sleep(Math.min(8000, 600 * Math.pow(2, attempt - 1))); continue; }
      return { ok: false, error: err.message || String(err), status: 0, model, tier };
    }
    if (RETRYABLE.has(resp.status) && attempt < 3) {
      const ra = Number(resp.headers.get("retry-after")) * 1000;
      await sleep(Number.isFinite(ra) && ra > 0 ? ra : Math.min(8000, 600 * Math.pow(2, attempt - 1)));
      continue;
    }
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (_e) { parsed = { raw: text.slice(0, 600) }; }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        data: parsed,
        model,
        tier,
        error: parsed?.error?.message || ("Gemini status " + resp.status),
      };
    }
    return { ok: true, status: resp.status, data: parsed, model, tier };
  }
  return { ok: false, status: 0, error: (lastErr?.message || "gemini exhausted retries"), model, tier };
};

// Helper: extract the first text part from a Gemini response.
export const extractTextFromGemini = (data) => {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  for (const p of parts) {
    if (typeof p?.text === "string" && p.text.length) return p.text;
  }
  return "";
};

// Helper: parse a structured-output response (JSON-mode) into an
// object. Returns { ok, value, error }.
export const parseStructuredGemini = (data) => {
  const txt = extractTextFromGemini(data);
  if (!txt) return { ok: false, error: "empty response" };
  try { return { ok: true, value: JSON.parse(txt) }; }
  catch (e) { return { ok: false, error: "non-json response: " + (e?.message || e), raw: txt.slice(0, 600) }; }
};

// Helper: surface stop reason / safety blocks for diagnostics.
export const stopReasonFromGemini = (data) => {
  const cand = data?.candidates?.[0];
  return cand?.finishReason || data?.promptFeedback?.blockReason || "unknown";
};
