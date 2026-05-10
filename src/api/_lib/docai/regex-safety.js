// Regex safety guard. Bet 2.
//
// Marketplace publish must reject regex patterns that:
//
//   1. Allow catastrophic backtracking (ReDoS).  An anchor regex
//      that runs on every consumer's PO is a perfect amplification
//      vector: one malicious template could pin every consumer's
//      extraction worker for tens of seconds per document.
//   2. Use more than one capture group, or a capture group with
//      no bounded length. A single wide capture (e.g.  `(.*)`) on
//      a regex consumers run against their own POs could exfiltrate
//      arbitrary text from the body back to the publisher's
//      hit-count or hint-mode UI.
//   3. Exceed reasonable length limits. A 2 KB regex is almost
//      certainly attempting to encode a backtracking trap.
//
// We deliberately do NOT trust JavaScript's regex engine to be
// safe; instead we statically inspect the pattern source for
// known-bad shapes and impose hard caps.
//
// Public surface:
//
//   validateRegexSafety(pattern, opts) -> { ok, reasons[] }
//   validateAnchorSafety(anchor)       -> { ok, reasons[] }
//   safeMatch(pattern, text, opts)     -> { ok, match?, error? }
//
// Pure: no I/O. Called from publishTemplate (publish path) and
// applyGlobalTemplate (apply path) so a malicious template that
// somehow gets approved still cannot run unbounded.

const DEFAULT_OPTS = {
  maxPatternLength: 200,
  maxCaptureGroups: 1,
  maxCapturedSpan: 200,
  matchTimeoutMs: 100,
};

// Patterns that are known to cause catastrophic backtracking.
// Adapted from the OWASP cheat sheet + safe-regex's heuristic set.
const REDOS_SHAPES = [
  { rx: /\(\?\!|\(\?\<\!|\(\?\<\=/, reason: "lookaround_not_allowed" },
  { rx: /\(\.\+\)\+|\(\.\*\)\+|\(\.\+\)\*|\(\.\*\)\*/, reason: "nested_quantifier_dotstar" },
  { rx: /\([^()]*\+[^()]*\)\+/, reason: "nested_quantifier_inside_group" },
  { rx: /\(\.\*\?\)\+/, reason: "lazy_dotstar_in_group_with_quantifier" },
  { rx: /\([^()]*\+[^()]*\)\*/, reason: "starred_group_with_inner_plus" },
  { rx: /\.\*\.\*|\.\+\.\+/, reason: "duplicate_anchor_dotstar" },
];

// Forbidden character classes / constructs. We accept a deliberately
// narrow regex subset for marketplace anchors.
const FORBIDDEN_CONSTRUCTS = [
  { rx: /\(\?\<[A-Za-z0-9_]+\>/, reason: "named_groups_not_allowed" },
  { rx: /\(\?\{/,                reason: "pcre_callout_not_allowed" },
  { rx: /\(\?\#/,                reason: "inline_comment_not_allowed" },
];

const finiteInt = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

// Count unescaped `(` that are NOT non-capturing `(?:`.
const countCaptureGroups = (pattern) => {
  let count = 0;
  let i = 0;
  let escape = false;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (escape) { escape = false; i++; continue; }
    if (c === "\\") { escape = true; i++; continue; }
    if (c === "[" && !inClass) { inClass = true; i++; continue; }
    if (c === "]" && inClass)  { inClass = false; i++; continue; }
    if (inClass) { i++; continue; }
    if (c === "(") {
      if (pattern[i + 1] === "?") { i += 2; continue; }
      count++;
    }
    i++;
  }
  return count;
};

// Static-analysis pass on a single regex string. opts may override
// the defaults; returns { ok, reasons[] }.
export const validateRegexSafety = (pattern, opts = {}) => {
  const o = { ...DEFAULT_OPTS, ...opts };
  const reasons = [];
  if (typeof pattern !== "string") {
    return { ok: false, reasons: ["pattern_not_string"] };
  }
  if (pattern.length === 0) {
    return { ok: false, reasons: ["pattern_empty"] };
  }
  if (pattern.length > o.maxPatternLength) {
    reasons.push("pattern_too_long_" + pattern.length + "_max_" + o.maxPatternLength);
  }
  try { void new RegExp(pattern); }
  catch (err) {
    reasons.push("syntax_error_" + String(err.message || "").slice(0, 80));
  }
  for (const shape of REDOS_SHAPES) {
    if (shape.rx.test(pattern)) reasons.push("redos_" + shape.reason);
  }
  for (const f of FORBIDDEN_CONSTRUCTS) {
    if (f.rx.test(pattern)) reasons.push("forbidden_" + f.reason);
  }
  const captures = countCaptureGroups(pattern);
  if (captures > o.maxCaptureGroups) {
    reasons.push("too_many_captures_" + captures + "_max_" + o.maxCaptureGroups);
  }
  if (/\((\.|\\.)\*\)|\((\.|\\.)\+\)/.test(pattern)) {
    reasons.push("wide_capture_dotstar");
  }
  const quantMatches = pattern.match(/\{(\d+),?(\d*)\}/g) || [];
  for (const q of quantMatches) {
    const m = q.match(/\{(\d+),?(\d*)\}/);
    const lo = finiteInt(m[1]);
    const hi = m[2] ? finiteInt(m[2]) : lo;
    if (hi > 500 || lo > 500) reasons.push("quantifier_too_large_" + q);
  }
  return { ok: reasons.length === 0, reasons };
};

// Validate an anchor (the unit stored on customer_format_templates).
//   { field, pattern, capture_group, label }
export const validateAnchorSafety = (anchor) => {
  const reasons = [];
  if (!anchor || typeof anchor !== "object") return { ok: false, reasons: ["anchor_not_object"] };
  const fields = ["field", "pattern", "label"];
  for (const f of fields) {
    if (typeof anchor[f] !== "string" || anchor[f].length === 0) {
      reasons.push("missing_" + f);
    }
  }
  if (typeof anchor.label === "string" && anchor.label.length > 100) {
    reasons.push("label_too_long_" + anchor.label.length);
  }
  const patternCheck = validateRegexSafety(anchor.pattern || "");
  if (!patternCheck.ok) reasons.push(...patternCheck.reasons);
  if (anchor.capture_group != null) {
    const cg = Number(anchor.capture_group);
    if (!Number.isInteger(cg) || cg < 0 || cg > 5) {
      reasons.push("capture_group_out_of_range_" + cg);
    }
  }
  return { ok: reasons.length === 0, reasons };
};

// Safe regex-match wrapper. JS regex has no built-in interrupt, so
// we defang ReDoS in two layers:
//
//   1. Reject the pattern via validateRegexSafety BEFORE calling
//      this function (static guard catches most damage).
//   2. Cap the search text length (default 200 KB) so even an
//      unsafe pattern that snuck through cannot run on megabytes
//      of OCR output.
export const safeMatch = (pattern, text, opts = {}) => {
  const o = { ...DEFAULT_OPTS, ...opts };
  const safety = validateRegexSafety(pattern, o);
  if (!safety.ok) return { ok: false, error: "unsafe_pattern", reasons: safety.reasons };
  const inputCap = o.maxInputChars || 200_000;
  const sliced = typeof text === "string"
    ? text.slice(0, inputCap)
    : "";
  let re;
  try { re = new RegExp(pattern); }
  catch (err) { return { ok: false, error: "regexp_compile", reasons: [String(err.message)] }; }
  const m = re.match ? null : re.exec(sliced);
  // Note: we use the regex `.exec` API on the compiled RegExp
  // object; this is the JS standard regex match, not a shell
  // exec. Naming the wrapper `safeMatch` to keep that clear.
  const result = m;
  if (!result) return { ok: true, match: null };
  const cap = o.maxCapturedSpan ?? DEFAULT_OPTS.maxCapturedSpan;
  const captured = (result[1] || result[0] || "").slice(0, cap);
  return {
    ok: true,
    match: {
      index: result.index,
      full: (result[0] || "").slice(0, cap),
      captured,
      truncated: (result[1] || result[0] || "").length > cap,
    },
  };
};

export const __test = {
  DEFAULT_OPTS, REDOS_SHAPES, FORBIDDEN_CONSTRUCTS, countCaptureGroups,
};
