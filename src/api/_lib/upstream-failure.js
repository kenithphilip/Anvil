// Name and classify an LLM upstream failure.
//
// Two production problems on 2026-10-06/07 come back to this file.
//
//   1. A retry loop that ended BECAUSE of a retryable status hid that status.
//      Google answered a 6-page PO with 503 "This model is currently
//      experiencing high demand", callGemini slept and retried until the run
//      budget was gone, and the attempt error read "run budget exhausted before
//      Gemini call". The real cause (an overloaded model) survived nowhere, so
//      the run looked like a budget bug.
//
//   2. Whether a failure is TRANSIENT decides whether "run extraction again
//      later" is honest advice. A 503 overload, a 429 or a timeout is. A 400, a
//      refusal or a parse failure is not, and telling an operator to retry one
//      wastes their time.
//
// Pure functions, no I/O. Shared by gemini.js and anthropic.js (which each
// speak a different error body) and by the docai dispatcher, which classifies
// an adapter result that did not classify itself.

// Statuses both providers treat as worth a retry. 529 is Anthropic's
// "overloaded_error".
export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

// The human message inside a provider error body. Gemini sends
// { error: { code, message, status } }, Anthropic sends
// { type: "error", error: { type, message } }, and both callers keep a
// non-JSON body as { raw }.
const messageOf = (body) => {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const e = body.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && e.message) return String(e.message);
  if (typeof body.raw === "string") return body.raw;
  if (typeof body.message === "string") return body.message;
  return "";
};

// The provider's own status word: Google's "UNAVAILABLE", Anthropic's
// "overloaded_error".
const statusWordOf = (body) => String(body?.error?.status || body?.error?.type || "");

const OVERLOAD_TEXT = /high demand|overloaded|over capacity/i;

/**
 * Is this response a model OVERLOAD (as opposed to a generic server error)?
 *
 * Overload is per model, so it is the one 5xx where retrying the same model
 * after a back-off is the wrong move and trying a different model is the
 * right one.
 */
export const isOverload = (status, body) => {
  const s = Number(status) || 0;
  if (s === 529) return true;
  if (s !== 503) return false;
  const word = statusWordOf(body);
  if (/^UNAVAILABLE$/i.test(word) || /overloaded/i.test(word)) return true;
  return OVERLOAD_TEXT.test(messageOf(body));
};

const TIMEOUT_TEXT = /did not respond within|timed out|timeout/i;
const NETWORK_TEXT = /unreachable|network error|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i;
const NO_BUDGET_TEXT = /run budget exhausted/i;

/**
 * Classify a failed upstream call.
 *
 * Returns { failure_class, transient }. failure_class is one of
 * overload | rate_limited | timeout | server_error | network | no_budget |
 * client_error | unknown.
 *
 * `status` is the HTTP status (0 when the call never got one), `body` the
 * parsed error body, `error` the thrown or reported message.
 */
export const classifyUpstreamFailure = ({ status, body, error } = {}) => {
  const s = Number(status) || 0;
  if (isOverload(s, body)) return { failure_class: "overload", transient: true };
  if (s === 429) return { failure_class: "rate_limited", transient: true };
  if (s === 408 || s === 504) return { failure_class: "timeout", transient: true };
  if (RETRYABLE_STATUSES.has(s)) return { failure_class: "server_error", transient: true };
  const text = String(error || "") + " " + messageOf(body);
  if (!s) {
    if (TIMEOUT_TEXT.test(text)) return { failure_class: "timeout", transient: true };
    if (NETWORK_TEXT.test(text)) return { failure_class: "network", transient: true };
    if (NO_BUDGET_TEXT.test(text)) return { failure_class: "no_budget", transient: true };
  }
  return { failure_class: s >= 400 ? "client_error" : "unknown", transient: false };
};

/**
 * One readable line for a retryable status, naming the status, what it means,
 * the model, and the provider's own words. For example:
 *
 *   503 model overloaded (high demand) on gemini-3.1-pro-preview: This model is
 *   currently experiencing high demand. Spikes in ...
 */
export const describeUpstreamStatus = ({ status, body, model } = {}) => {
  const s = Number(status) || 0;
  const msg = messageOf(body).replace(/\s+/g, " ").trim().slice(0, 160);
  let label;
  if (isOverload(s, body)) label = s + " model overloaded" + (/high demand/i.test(msg) ? " (high demand)" : "");
  else if (s === 429) label = "429 rate limited";
  else if (s === 408 || s === 504) label = s + " upstream timeout";
  else label = s + " upstream error";
  return label + (model ? " on " + model : "") + (msg ? ": " + msg : "");
};
