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
import { applyFirewall, redactMessages, capRetrySleep, attemptTimeout } from "./anthropic.js";
import { isOverload, classifyUpstreamFailure, describeUpstreamStatus } from "./upstream-failure.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Gemini 3 family. Matches both the preview spelling ("gemini-3-flash-preview")
// and the dotted stable one ("gemini-3.6-flash", "gemini-3.1-pro-preview").
export const IS_GEMINI_3 = /gemini-3(?:[.-]|$)/i;

// mediaResolution is a protobuf ENUM, not a free string: the wire value must be
// the full "MEDIA_RESOLUTION_*" name. Sending the bare word 400s the request:
//
//   Invalid value at 'generation_config.media_resolution'
//   (...v1beta.GenerationConfig.MediaResolution), "high"
//
// Anvil stores the friendly word ("high") in tenant_settings and
// GEMINI_MEDIA_RESOLUTION, and passed it through verbatim. That was latent for
// as long as the family test was /3-/ — which does not match "gemini-3.6-flash"
// — so the knob was never actually sent. Widening the regex to IS_GEMINI_3 made
// it start applying, and Gemini began 400ing in ~100ms on EVERY call: not one
// document, the whole primary adapter, silently demoted to the fallbacks.
//
// So translate at the wire edge rather than migrating the stored vocabulary.
// Already-prefixed values pass through, which keeps the escape hatch open if an
// operator sets the raw enum in env.
const MEDIA_RESOLUTION_ENUM = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
  ultra_high: "MEDIA_RESOLUTION_ULTRA_HIGH",
};
export const toMediaResolutionEnum = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^MEDIA_RESOLUTION_[A-Z_]+$/.test(s)) return s;
  return MEDIA_RESOLUTION_ENUM[s.toLowerCase()] || null;
};

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run-budget guards, mirroring callAnthropic (see anthropic.js). Without these
// callGemini could run 3 attempts x 60s with an UNCAPPED retry-after sleep —
// far past docai's 45s RUN_BUDGET_MS and past vercel.json's maxDuration of 60,
// so the platform killed the function mid-flight and run.js never wrote its
// final UPDATE. The row then sat at status='running' forever with no attempts
// and no error, while the provider call was still billed. Gemini is FIRST in
// the default provider order, so it is the likeliest adapter to strand a run.
// deadlineAt=0 (every non-docai caller) collapses all of this to the previous
// behaviour exactly.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60_000);
const GEMINI_FALLBACK_RESERVE_MS = Number(process.env.GEMINI_FALLBACK_RESERVE_MS || 8000);
const MIN_ATTEMPT_MS = 2000;

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
// Gemini's generationConfig.responseSchema is an OpenAPI-3.0 Schema SUBSET, not
// full JSON Schema. Our extraction schemas (docai/gemini.js, kept in lockstep
// with claude.js) express a nullable field as a union `type: ["string","null"]`
// — which Gemini rejects outright ("Invalid JSON payload ... Unknown name
// 'type' ... Proto field is not repeating"), failing the whole call before it
// runs. This converts to the subset Gemini accepts:
//   - a nullable union `type: [T, "null"]`  ->  `type: T` + `nullable: true`
//   - unknown JSON-Schema keywords (additionalProperties, $schema, $ref, …) are
//     dropped so they can't 400 the request.
// Recurses through properties + items. Pure + exported for tests.
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties",
  "required", "minItems", "maxItems", "minimum", "maximum", "propertyOrdering",
]);
export const toGeminiSchema = (schema) => {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  // Collapse a nullable union to a scalar type + the `nullable` flag.
  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    if (type.includes("null")) nullable = true;
    type = type.find((t) => t !== "null") ?? null;
  }
  if (type != null) out.type = type;
  if (nullable) out.nullable = true;

  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" || k === "nullable") continue;   // handled above
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;         // drop unsupported keywords
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]),
      );
    } else if (k === "items") {
      out.items = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
};

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
  // Gemini 3 reasoning depth: "LOW" | "MEDIUM" | "HIGH".
  //
  // Thinking tokens come out of the SAME maxOutputTokens budget as the answer,
  // and Gemini 3 models think by DEFAULT (gemini-3.6-flash ships at MEDIUM).
  // That is why a 13-page / 45-line PO truncated at max_tokens 8000 even though
  // the line array alone needs only ~4,800 tokens: medium reasoning consumed
  // the remainder and the JSON was cut mid-array.
  //
  // Undefined here so no existing caller changes behaviour — the docai
  // extraction path opts in explicitly, because structured line-item
  // extraction is mechanical (responseSchema carries the structure) and every
  // token spent reasoning is a token not spent on a line item.
  // Must NOT be combined with the legacy thinking_budget (Google returns 400).
  thinking_level,
  // Optional run deadline (epoch ms) threaded from the docai pipeline, exactly
  // as callAnthropic takes it. 0 => no deadline and every guard below collapses
  // to the historical behaviour.
  deadlineAt: deadlineAtOpt,
  // A second Gemini model to try when the first answers 503 overloaded /
  // "high demand" (docai/model_selector.js selectGeminiFallbackModel picks it
  // for extraction). Omitted => no switch, and
  // every non-docai caller behaves exactly as before.
  fallback_model: fallbackModelOpt,
  // The tail to leave for whatever runs after this call. Defaults to
  // GEMINI_FALLBACK_RESERVE_MS. The docai dispatcher passes 0 because the
  // deadline it hands over ALREADY holds back the next adapters' time.
  reserveMs: reserveMsOpt,
}) => {
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY missing", status: 0, failure_class: "client_error", transient: false };
  }
  const deadlineAt = Number(deadlineAtOpt) || 0;
  const { model } = pickGeminiModel({ tier, override: modelOverride });

  const firewalledSystem = applyFirewall(system);
  const redactedMessages = redactMessages(messages, redactionRules);

  // The request body depends on the model being called: mediaResolution and
  // thinkingConfig are Gemini 3 knobs, and sending them to an older fallback
  // model would 400 the call.
  const buildBody = (forModel) => {
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
      body.generationConfig.responseSchema = toGeminiSchema(response_schema);
    } else if (response_mime_type) {
      body.generationConfig.responseMimeType = response_mime_type;
    }

    // Bet 1: Gemini 3 media_resolution knob. Defaults inflate token
    // count vs 2.5 Flash because 3 Flash treats every image at high
    // resolution unless told otherwise; we pin to the env default
    // ("high") to stay in the same cost band as 2.5 was.
    //
    // The family test was /3-/, which matches "gemini-3-flash-preview" but NOT
    // "gemini-3.6-flash" (that reads "3.6-", with no "3-" substring). So this
    // knob silently stopped applying the moment the deployment moved to
    // gemini-3.6-flash. IS_GEMINI_3 matches both spellings.
    const resolvedMediaRes = media_resolution
      || process.env.GEMINI_MEDIA_RESOLUTION
      || "high";
    if (resolvedMediaRes && IS_GEMINI_3.test(forModel)) {
      const mr = toMediaResolutionEnum(resolvedMediaRes);
      // An unmappable word (typo in env, or a value some future admin build lets
      // through) must NOT be forwarded: that is the 400 we are fixing. Omitting
      // the field falls back to Google's own default, which is what shipped for
      // every release before the knob started applying.
      //
      // ULTRA_HIGH is documented as per-PART only; at generationConfig level it is
      // rejected. Dropping it here means a tenant configured that way gets a
      // working extraction at the default resolution instead of a hard 400 on
      // every document.
      if (mr && mr !== "MEDIA_RESOLUTION_ULTRA_HIGH") {
        body.generationConfig.mediaResolution = mr;
      }
    }

    // Reasoning depth. See the thinking_level param doc above: Gemini 3 thinks by
    // default and those tokens come out of maxOutputTokens, so on a long
    // line-item table the reasoning crowds out the answer. Only sent when the
    // caller asks for it, so existing callers are untouched.
    if (thinking_level && IS_GEMINI_3.test(forModel)) {
      body.generationConfig.thinkingConfig = {
        // LOWERCASE. Google's REST reference documents the accepted values as
        // "minimal" | "low" | "medium" | "high" and its curl example sends
        // {"thinkingConfig": {"thinkingLevel": "low"}}. This was .toUpperCase()
        // on first write, which risked a 400 on an unknown enum value, and a
        // 400 here fails the request outright, so it would have broken EVERY
        // extraction, not just the long ones this setting is aimed at.
        thinkingLevel: String(thinking_level).toLowerCase(),
      };
    }
    return JSON.stringify(body);
  };
  // Built once per model: a retry re-sends the same bytes, and the body can
  // carry a multi-MB base64 PDF.
  const bodies = new Map();
  const bodyFor = (m) => {
    if (!bodies.has(m)) bodies.set(m, buildBody(m));
    return bodies.get(m);
  };

  const urlFor = (m) => GEMINI_BASE + "/" + encodeURIComponent(m) + ":generateContent";
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  const reserveMs = reserveMsOpt != null && Number.isFinite(Number(reserveMsOpt))
    ? Math.max(0, Number(reserveMsOpt))
    : GEMINI_FALLBACK_RESERVE_MS;
  const retryOpts = { deadlineAt, reserveMs };
  const fallbackModel = typeof fallbackModelOpt === "string" && fallbackModelOpt.trim()
    && fallbackModelOpt.trim() !== model
    ? fallbackModelOpt.trim()
    : null;

  // OVERLOAD FAST PATH. A 503 "overloaded" / "high demand" used to get the same
  // treatment as any 5xx: back off and retry the SAME model, three times.
  // Overload is per model, so those retries mostly buy more 503s, and Google
  // can take about 8s to send each one. On 2026-10-07 two of them spent 19.9s
  // of the run and left Claude 5.5s. Now, after one overload:
  //   - with a fallback model, switch to it at once (no sleep: it has its own
  //     capacity), and stop if it is overloaded too;
  //   - without one, allow ONE short retry of the same model, then stop.
  // Either way the dispatcher gets the run back, with time left, after at most
  // two overloaded calls. Only on budgeted (docai) runs or when the caller asked
  // for a fallback model; every other caller keeps the historical loop.
  //
  // A 429 is NOT an overload: it keeps the Retry-After back-off below.
  const overloadFastPath = !!(deadlineAt || fallbackModel);

  let current = model;
  let fallbackFrom = null;
  let firstOverload = null;
  let overloadRetryUsed = false;
  // What ended the last attempt: a retryable status or a thrown error. Kept so
  // a budget stop names the real cause ("503 model overloaded ...") instead of
  // "run budget exhausted before Gemini call", which is what hid the overload
  // on 2026-10-07.
  let lastFailure = null;
  // One entry per HTTP call, so a run can show "pro 503, then flash ok".
  const modelAttempts = [];

  const describe = (f) => describeUpstreamStatus({ status: f.status, body: f.body, model: f.model });
  // When the fallback model failed too, say what the primary did first.
  const withHistory = (msg) => {
    if (!firstOverload || !fallbackFrom) return msg;
    const first = describe(firstOverload);
    return msg.startsWith(first) ? msg : first + "; then " + msg;
  };
  const fail = (extra) => ({
    ok: false,
    model: current,
    tier,
    model_attempts: modelAttempts,
    ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
    ...extra,
  });
  const failFromStatus = (f, suffix = "") => fail({
    status: f.status,
    data: f.body,
    error: withHistory(describe(f) + suffix),
    ...classifyUpstreamFailure({ status: f.status, body: f.body }),
  });
  const failFromMessage = (message) => fail({
    status: 0,
    error: withHistory(message),
    ...classifyUpstreamFailure({ status: 0, error: message }),
  });
  const readBody = async (resp) => {
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { raw: text.slice(0, 600) }; }
  };

  const MAX_CALLS = 3;
  for (let attempt = 1; attempt <= MAX_CALLS; attempt++) {
    // Time-box this attempt to the remaining run budget (minus the reserve that
    // keeps a downstream adapter viable), capped at the normal ceiling.
    const attemptTimeoutMs = attemptTimeout({ ...retryOpts, ceilingMs: GEMINI_TIMEOUT_MS });
    if (deadlineAt && attemptTimeoutMs < MIN_ATTEMPT_MS) {
      // Not enough budget left to try without starving the fallback, and
      // starting a call we cannot finish is what strands the run.
      if (lastFailure?.kind === "status") return failFromStatus(lastFailure, "; run budget exhausted before a retry");
      return failFromMessage(lastFailure?.message
        ? lastFailure.message + "; run budget exhausted before a retry"
        : "run budget exhausted before Gemini call");
    }
    const t0 = Date.now();
    let resp;
    try {
      resp = await safeFetch(urlFor(current), { method: "POST", headers, body: bodyFor(current), timeoutMs: attemptTimeoutMs });
    } catch (err) {
      const message = err?.message || String(err);
      lastFailure = { kind: "error", message };
      modelAttempts.push({ model: current, status: 0, ms: Date.now() - t0, error: message.slice(0, 200) });
      const wait = attempt < MAX_CALLS ? capRetrySleep(600 * Math.pow(2, attempt - 1), retryOpts) : null;
      if (wait != null) { await sleep(wait); continue; }
      return failFromMessage(message);
    }
    if (RETRYABLE.has(resp.status)) {
      const body = await readBody(resp);
      // failure_class per model, so the docai circuit breaker can tell "every
      // model was overloaded" from "one was, and the next timed out".
      modelAttempts.push({
        model: current, status: resp.status, ms: Date.now() - t0,
        failure_class: classifyUpstreamFailure({ status: resp.status, body }).failure_class,
      });
      lastFailure = { kind: "status", status: resp.status, body, model: current };
      if (overloadFastPath && isOverload(resp.status, body)) {
        if (!firstOverload) firstOverload = lastFailure;
        if (fallbackModel && current !== fallbackModel) {
          fallbackFrom = current;
          current = fallbackModel;
          continue;
        }
        if (!fallbackModel && !overloadRetryUsed && attempt < MAX_CALLS) {
          overloadRetryUsed = true;
          const wait = capRetrySleep(600, retryOpts);
          if (wait != null) { await sleep(wait); continue; }
        }
        return failFromStatus(lastFailure);
      }
      if (attempt < MAX_CALLS) {
        const ra = Number(resp.headers.get("retry-after")) * 1000;
        const base = Number.isFinite(ra) && ra > 0 ? ra : 600 * Math.pow(2, attempt - 1);
        // wait == null => the budget won't allow another round trip; return
        // this response so the ladder moves on immediately.
        const wait = capRetrySleep(base, retryOpts);
        if (wait != null) { await sleep(wait); continue; }
      }
      return failFromStatus(lastFailure);
    }
    const parsed = await readBody(resp);
    modelAttempts.push({ model: current, status: resp.status, ms: Date.now() - t0 });
    if (!resp.ok) {
      return fail({
        status: resp.status,
        data: parsed,
        error: withHistory(parsed?.error?.message || ("Gemini status " + resp.status)),
        ...classifyUpstreamFailure({ status: resp.status, body: parsed }),
      });
    }
    return {
      ok: true,
      status: resp.status,
      data: parsed,
      model: current,
      tier,
      model_attempts: modelAttempts,
      ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
    };
  }
  // Every path above returns or continues inside the call cap, so this is not
  // reached today. It stays so a future edit cannot fall off the end silently.
  if (lastFailure?.kind === "status") return failFromStatus(lastFailure);
  return failFromMessage(lastFailure?.message || "gemini exhausted retries");
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
