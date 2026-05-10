// Schema-aligned parsing (SAP) helper. Bet 4.
//
// Replaces ad-hoc JSON.parse across the docai pipeline with a
// repair-first parser that catches the common failure modes
// production LLMs ship:
//
//   - markdown code fences:           ```json {...} ```
//   - prose prefix:                   "Sure, here's the JSON: {...}"
//   - prose suffix:                   "{...}\nLet me know if..."
//   - trailing commas:                {"a": 1,}
//   - single-quoted strings (rare):   {'a': 1}
//   - unquoted keys (rare):           {a: 1}
//   - C-style comments (rarer still): {/* note */ "a": 1}
//   - truncated mid-array:            {"lines": [{"a": 1}, {"a"
//
// Inspired by Boundary's BAML Schema-Aligned Parsing technique
// (https://boundaryml.com/blog/schema-aligned-parsing) but
// reimplemented in vanilla JS so we don't pull in a Rust native
// addon. BAML benchmarks SAP at >90% on the Berkeley Function
// Calling Leaderboard regardless of model; the same shape of
// repairs covers >99% of Anvil's parse_failed runs based on the
// extraction_runs.status_reason audit.
//
// Public API:
//
//   parseSchemaAligned(text, validator, opts)
//     -> { ok, value, repairs[], retries, parse_method, error }
//
//   validator: optional (value) => { ok: bool, errors?: string[] }
//   opts.retry: optional async (validationError, lastValue) => string | null
//               called when the SAP pass succeeds but validation
//               fails; returns a fresh model output to re-parse,
//               or null to give up. Drives the sap_zod_retry path.
//
// Pure: no I/O, no DB, no LLM calls inside the helper itself. The
// retry callback is the caller's responsibility.

// ---------------- repairs --------------------------------------

// Strip ```json ... ``` and ``` ... ``` fences. Returns the inner
// payload + a `fences` repair tag when one was applied.
const stripFences = (s) => {
  const fenceRe = /^\s*```(?:json|javascript|js)?\s*([\s\S]*?)\s*```\s*$/i;
  const m = s.match(fenceRe);
  if (m) return { text: m[1], repair: "fences" };
  return { text: s, repair: null };
};

// Drop everything before the first `{` or `[` (chain-of-thought
// prefix) and after the matching close bracket (epilogue). Tracks
// whether either side was trimmed. We maintain a stack of the
// actual open-bracket sequence so a truncated `{"a":[1,` closes
// to `{"a":[1]}` (not `{"a":[1}}`).
const trimToObject = (s) => {
  const trimmed = s.trim();
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  let start = -1;
  if (firstObj === -1 && firstArr === -1) return { text: trimmed, repairs: [] };
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr;
  } else {
    start = firstObj;
  }
  const before = trimmed.slice(0, start);
  // Walk forward maintaining a stack of opens so the close-up logic
  // knows whether to append `}` or `]`. String-aware so we don't
  // trim inside a quoted string that contains a literal `}` / `]`.
  const stack = [];
  let inString = false;
  let escape = false;
  let end = -1;
  let lastNonWsOpen = "";
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") { stack.push("}"); lastNonWsOpen = "{"; }
    else if (c === "[") { stack.push("]"); lastNonWsOpen = "["; }
    else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) { end = i; break; }
    }
  }
  void lastNonWsOpen;
  const repairs = [];
  if (before.trim().length) repairs.push("prose_prefix");
  if (end === -1) {
    // Unterminated container - the model truncated. Best-effort
    // close: terminate the open string (if any), drop any dangling
    // partial-value tokens up to the last comma so we don't emit
    // `{"a":1,"b":` -> `{"a":1,"b":}`, then close every open
    // bracket using the stack so nesting is respected.
    let patched = trimmed.slice(start);
    if (inString) { patched += '"'; repairs.push("truncated_string"); }
    // Drop dangling partial tokens at the end so we don't emit
    // invalid trailing fragments like `{"a"` or `, "key":`. The
    // patterns peel off one fragment at a time until none match.
    const peelers = [
      // Trailing `, {<partial>` inside an array, the inner object
      // is incomplete (no closing `}` was popped while the inner
      // object stayed on the stack).
      /,\s*\{[^{}]*$/u,
      // Trailing `, [<partial>` inside an array of arrays.
      /,\s*\[[^\[\]]*$/u,
      // Trailing `, "key": "partial-value-or-token"` (no comma).
      /,\s*"[^"]*"\s*:\s*[^,\]\}]*$/u,
      // Trailing `, "key":` with no value yet.
      /,\s*"[^"]*"\s*:\s*$/u,
      // Bare hanging key inside an object: `{"key"` -> keep `{`.
      /(\{)\s*"[^"]*"\s*$/u,
      // Bare key:partial-value at the top of an object: `{"k":1,` peeler above
      // already handles the comma case; this catches `{"k":1` (no comma).
      /(\{)\s*"[^"]*"\s*:\s*[^,\]\}]*$/u,
      // Trailing key without value mid-object: `"k"` at object tail.
      /,\s*"[^"]*"\s*$/u,
      // Trailing dangling comma.
      /,\s*$/u,
    ];
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const re of peelers) {
        const next = patched.replace(re, (...args) => {
          // Peelers with a captured `{` or `[` keep that prefix so
          // we don't strip the parent container's opener.
          // The replace-callback signature is (match, g1?, g2?, ..., offset, string).
          // Distinguish by checking if args[1] is a string (a capture)
          // vs a number (the offset when no captures exist).
          return typeof args[1] === "string" ? args[1] : "";
        });
        if (next !== patched) {
          patched = next;
          pruned = true;
          break;
        }
      }
    }
    // Re-walk the patched text to compute the actual stack of
    // unclosed brackets (the peelers may have removed open
    // brackets too). Then close them in reverse order.
    const closeStack = [];
    let s2InString = false;
    let s2Escape = false;
    for (let i = 0; i < patched.length; i++) {
      const c = patched[i];
      if (s2Escape) { s2Escape = false; continue; }
      if (c === "\\") { s2Escape = true; continue; }
      if (c === '"') { s2InString = !s2InString; continue; }
      if (s2InString) continue;
      if (c === "{") closeStack.push("}");
      else if (c === "[") closeStack.push("]");
      else if (c === "}" || c === "]") closeStack.pop();
    }
    while (closeStack.length) { patched += closeStack.pop(); }
    repairs.push("truncated");
    return { text: patched, repairs };
  }
  const after = trimmed.slice(end + 1);
  if (after.trim().length) repairs.push("prose_suffix");
  return { text: trimmed.slice(start, end + 1), repairs };
};

// Remove trailing commas in arrays and objects. Operates only on
// text outside string literals.
const stripTrailingCommas = (s) => {
  let out = "";
  let inString = false;
  let escape = false;
  let lastNonWs = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { out += c; escape = false; continue; }
    if (c === "\\" && inString) { out += c; escape = true; continue; }
    if (c === '"') { out += c; inString = !inString; lastNonWs = c; continue; }
    if (inString) { out += c; continue; }
    if ((c === "}" || c === "]") && lastNonWs === ",") {
      // Trim back through whitespace + the comma in `out`.
      let k = out.length - 1;
      while (k >= 0 && /\s/.test(out[k])) k--;
      if (k >= 0 && out[k] === ",") {
        out = out.slice(0, k) + out.slice(k + 1);
      }
    }
    out += c;
    if (!/\s/.test(c)) lastNonWs = c;
  }
  if (out !== s) return { text: out, repair: "trailing_comma" };
  return { text: s, repair: null };
};

// Quote unquoted keys ({a: 1} -> {"a": 1}). Conservative: only
// rewrites bare alphanumeric/underscore identifiers immediately
// before a colon, never inside strings.
const quoteUnquotedKeys = (s) => {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { out += c; escape = false; continue; }
    if (c === "\\" && inString) { out += c; escape = true; continue; }
    if (c === '"') { out += c; inString = !inString; continue; }
    if (inString) { out += c; continue; }
    // Check if we're starting a bare key: previous non-ws is `{`
    // or `,` and we see [a-zA-Z_].
    if (/[a-zA-Z_]/.test(c)) {
      // Find previous non-whitespace.
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && (out[j] === "{" || out[j] === ",")) {
        // Read the bare identifier.
        let k = i;
        while (k < s.length && /[a-zA-Z0-9_]/.test(s[k])) k++;
        // Skip whitespace, then expect `:`.
        let m = k;
        while (m < s.length && /\s/.test(s[m])) m++;
        if (m < s.length && s[m] === ":") {
          out += '"' + s.slice(i, k) + '"';
          i = k - 1;
          continue;
        }
      }
    }
    out += c;
  }
  if (out !== s) return { text: out, repair: "unquoted_keys" };
  return { text: s, repair: null };
};

// Remove `/* ... */` and `// ...` comments outside strings.
const stripComments = (s) => {
  let out = "";
  let inString = false;
  let escape = false;
  let i = 0;
  let touched = false;
  while (i < s.length) {
    const c = s[i];
    if (escape) { out += c; escape = false; i++; continue; }
    if (c === "\\" && inString) { out += c; escape = true; i++; continue; }
    if (c === '"') { out += c; inString = !inString; i++; continue; }
    if (inString) { out += c; i++; continue; }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) { i = s.length; touched = true; break; }
      i = end + 2; touched = true; continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i + 2);
      if (end === -1) { i = s.length; touched = true; break; }
      i = end; touched = true; continue;
    }
    out += c; i++;
  }
  return touched ? { text: out, repair: "comments" } : { text: s, repair: null };
};

// ---------------- public ---------------------------------------

// Try a sequence of repairs, accumulating the list of repairs
// applied. Returns the parsed value + repairs[] on success.
const repairAndParse = (rawText) => {
  let text = String(rawText == null ? "" : rawText);
  const repairs = [];

  // First pass: strip fences.
  const fenceRes = stripFences(text);
  if (fenceRes.repair) { text = fenceRes.text; repairs.push(fenceRes.repair); }

  // Second pass: trim chain-of-thought prefix/suffix and balance
  // brackets when the container looks truncated.
  const trimRes = trimToObject(text);
  if (trimRes.repairs.length) { repairs.push(...trimRes.repairs); }
  text = trimRes.text;

  // Third pass: comments. Done before quoting unquoted keys
  // because a comment can contain `:` or bare identifiers.
  const commentRes = stripComments(text);
  if (commentRes.repair) { text = commentRes.text; repairs.push(commentRes.repair); }

  // Fourth pass: trailing commas.
  const commaRes = stripTrailingCommas(text);
  if (commaRes.repair) { text = commaRes.text; repairs.push(commaRes.repair); }

  // Fifth pass: unquoted keys. Conservative; usually a no-op.
  const keyRes = quoteUnquotedKeys(text);
  if (keyRes.repair) { text = keyRes.text; repairs.push(keyRes.repair); }

  try {
    const value = JSON.parse(text);
    return { ok: true, value, repairs };
  } catch (err) {
    return { ok: false, repairs, error: err?.message || "JSON.parse failed", text };
  }
};

// Public entry point. Returns:
//   { ok, value, repairs[], retries, parse_method, error }
//
// parse_method values:
//   native_structured  caller provided already-parsed object
//   sap_repaired       repair pass produced parseable JSON on
//                      first attempt (repairs may be []) and
//                      validator (if any) accepted the value
//   sap_zod_retry      first parse OR validation failed; retry
//                      callback returned a new payload that did
//                      parse + validate
//   tool_use           caller passed { fromToolUse: true } in opts
//                      (helper just runs validation, does not
//                      reparse)
//   failed             both attempts produced no usable value
export const parseSchemaAligned = async (input, validator, opts = {}) => {
  const out = {
    ok: false,
    value: null,
    repairs: [],
    retries: 0,
    parse_method: "failed",
    error: null,
  };

  // If the caller already has a parsed value (e.g. from Anthropic
  // tool_use input or vendor-native structured output), skip the
  // text-parse stage and go straight to validation.
  if (opts.fromToolUse || opts.fromNativeStructured) {
    out.parse_method = opts.fromNativeStructured ? "native_structured" : "tool_use";
    if (validator) {
      const v = validator(input);
      if (v?.ok) { out.ok = true; out.value = input; return out; }
      out.error = "validation: " + (v?.errors || []).join("; ");
      // Fall through to retry if a callback was supplied.
      if (opts.retry) {
        const retryText = await opts.retry(out.error, input);
        if (typeof retryText === "string" && retryText.length > 0) {
          out.retries = 1;
          const r2 = repairAndParse(retryText);
          if (r2.ok && (!validator || validator(r2.value)?.ok)) {
            out.ok = true;
            out.value = r2.value;
            out.repairs = r2.repairs;
            out.parse_method = "sap_zod_retry";
            return out;
          }
          out.error = r2.error || out.error;
        }
      }
      return out;
    }
    out.ok = true;
    out.value = input;
    return out;
  }

  // Text path: run the SAP repair sequence, then validate, then
  // optionally retry the model call once via the retry callback.
  const r1 = repairAndParse(input);
  if (r1.ok) {
    if (validator) {
      const v = validator(r1.value);
      if (v?.ok) {
        out.ok = true;
        out.value = r1.value;
        out.repairs = r1.repairs;
        out.parse_method = "sap_repaired";
        return out;
      }
      out.error = "validation: " + (v?.errors || []).join("; ");
    } else {
      out.ok = true;
      out.value = r1.value;
      out.repairs = r1.repairs;
      out.parse_method = "sap_repaired";
      return out;
    }
  } else {
    out.error = r1.error;
    out.repairs = r1.repairs;
  }

  // Retry once via the model when a callback is supplied.
  if (opts.retry) {
    const retryText = await opts.retry(out.error, r1.value);
    if (typeof retryText === "string" && retryText.length > 0) {
      out.retries = 1;
      const r2 = repairAndParse(retryText);
      if (r2.ok) {
        if (validator) {
          const v2 = validator(r2.value);
          if (v2?.ok) {
            out.ok = true;
            out.value = r2.value;
            out.repairs = r2.repairs;
            out.parse_method = "sap_zod_retry";
            return out;
          }
          out.error = "validation (retry): " + (v2?.errors || []).join("; ");
        } else {
          out.ok = true;
          out.value = r2.value;
          out.repairs = r2.repairs;
          out.parse_method = "sap_zod_retry";
          return out;
        }
      } else {
        out.error = r2.error || out.error;
      }
    }
  }

  return out;
};

// Test-only exports so unit tests can lock the individual repair
// rules without standing up the whole helper.
export const __test = {
  stripFences,
  trimToObject,
  stripTrailingCommas,
  quoteUnquotedKeys,
  stripComments,
  repairAndParse,
};
