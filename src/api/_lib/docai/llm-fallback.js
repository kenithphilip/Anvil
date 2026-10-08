// Did a fallback PARSER read this document because every LLM was busy?
//
// On 2026-10-06 and 10-07 one 6-page PO was read five times by LlamaParse, a
// document parser, after Gemini answered 503 "high demand" and Claude timed
// out. The parse had no header fields and split every multi-row item into four
// lines. Nothing on the run said why: it looked like an ordinary weak
// extraction, so nobody knew that running it again an hour later would very
// likely give a proper one.
//
// This names that case so the SO workspace can say so. It is deliberately
// narrow. The marker is set only when:
//   - the run succeeded, and a non-LLM adapter produced the result;
//   - no LLM produced any result at all (a low-confidence LLM result means an
//     LLM WAS available);
//   - at least one LLM really tried and failed with a TRANSIENT error
//     (overload, rate limit, timeout, network);
//   - every other LLM either failed transiently too or was skipped for lack of
//     run time, which the busy ones used up;
//   - an LLM the circuit breaker skipped (skipped_circuit_open) counts as busy:
//     the breaker skips a provider only after it was overloaded on every model
//     within the last few minutes (circuit-breaker.js).
// A 400, a refusal, a parse failure, a cost cap or a thrown adapter all mean
// "retry later" is not the fix, so any of them leaves the marker off. An LLM
// that is not configured, or that has no schema for this kind of document, is
// ignored: it was never in a position to help.
//
// Pure. Reads the dispatcher's attempt records, which carry `transient` (see
// index.js) and survive the chunk merge.

import { CIRCUIT_OPEN_STATUS } from "./circuit-breaker.js";

// Adapters that ask a language model to read the document. llamaparse is a
// parsing engine even though it sits in index.js's LLM_FALLBACK_ADAPTERS
// list; docling, marker, unstructured, azure_di and reducto are parsers too.
export const LLM_EXTRACTOR_ADAPTERS = Object.freeze(["gemini", "claude", "openrouter"]);
export const isLlmExtractor = (name) => LLM_EXTRACTOR_ADAPTERS.includes(name);

export const LLM_UNAVAILABLE_CODE = "llm_unavailable_fallback_parse";

// Skips caused by the run running out of time, not by the adapter itself.
const TIME_SKIPS = new Set(["skipped_deadline", "skipped_insufficient_budget"]);
// A skip by the provider circuit breaker. The provider was overloaded, which
// is transient, so it counts like a transient failure.
const CIRCUIT_OPEN = CIRCUIT_OPEN_STATUS;
const isBusy = (a) => a.status === CIRCUIT_OPEN || (a.status === "failed" && a.transient === true);
// Attempts that say the adapter could never have read this document.
const NOT_APPLICABLE = (a) => a.status === "skipped_not_configured" || a.reason === "unsupported_kind";

/**
 * Returns null, or { adapter, llm_attempts } describing why the LLMs did not
 * read the document.
 */
export const llmUnavailableFallback = ({ ok, adapterUsed, attempts } = {}) => {
  if (!ok || !adapterUsed || adapterUsed === "voter" || isLlmExtractor(adapterUsed)) return null;
  const llm = (Array.isArray(attempts) ? attempts : []).filter((a) => a && isLlmExtractor(a.adapter));
  const relevant = llm.filter((a) => !NOT_APPLICABLE(a));
  const failed = relevant.filter((a) => a.status === "failed" || a.status === CIRCUIT_OPEN);
  if (!failed.length) return null;
  if (!failed.every(isBusy)) return null;
  // Every LLM that could have read it either failed, was skipped as busy, or
  // ran out of time. An ok or low_confidence attempt (an LLM DID answer), a
  // cost-cap skip or a thrown adapter all stop the marker here.
  if (!relevant.every((a) => a.status === "failed" || a.status === CIRCUIT_OPEN || TIME_SKIPS.has(a.status))) return null;
  return {
    adapter: adapterUsed,
    llm_attempts: relevant.map((a) => ({
      adapter: a.adapter,
      status: a.status,
      ...(a.failure_class ? { failure_class: a.failure_class } : {}),
      ...(a.status === CIRCUIT_OPEN && a.window_minutes ? { window_minutes: a.window_minutes } : {}),
      ...(a.error ? { error: String(a.error).slice(0, 200) } : {}),
    })),
  };
};

const skippedWhy = (a) => (a.status === CIRCUIT_OPEN
  ? "skipped, overloaded in the last " + (a.window_minutes || "few") + " minutes"
  : "skipped, no time left");

const PLAIN_CLASS = {
  overload: "overloaded",
  rate_limited: "rate limited",
  timeout: "timed out",
  server_error: "server error",
  network: "network error",
  no_budget: "no time left",
};

/**
 * The marker as an anomaly row, in the shape detectAnomalies emits, so it is
 * persisted on extraction_runs.anomalies and listed by the extraction-quality
 * card with no new column. Severity warn: it asks for a check, it does not
 * block approval.
 */
export const llmUnavailableAnomaly = (marker) => {
  if (!marker) return null;
  const why = marker.llm_attempts
    .map((a) => a.adapter + " " + (a.status === "failed"
      ? (PLAIN_CLASS[a.failure_class] || "failed")
      : skippedWhy(a)))
    .join(", ");
  return {
    code: LLM_UNAVAILABLE_CODE,
    severity: "warn",
    path: "document",
    actual: marker.adapter,
    detail: "The AI models were busy (" + why + "), so the fallback parser (" + marker.adapter
      + ") read this document. Check the header and the lines. Run extraction again later for a better result.",
    llm_attempts: marker.llm_attempts,
  };
};
