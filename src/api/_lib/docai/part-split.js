// Deterministic part-code / description split.
//
// The extraction prompt already tells the model to pull our part code out of a
// prefixed description ("OBARA STD SHANK TWS-092-90-2" -> "TWS-092-90-2",
// claude.js rule (c)). But the split lived ENTIRELY inside the LLM: there was
// no post-processor anywhere, and validators.js only warns when a line has
// NEITHER a partNumber nor a description — never that partNumber is a whole
// sentence. So when the model returned the uncut cell, nothing noticed, and
// two things then went wrong downstream:
//
//   1. customer-hints.js derives "customer part-number prefixes" from
//      line.partNumber with /^([A-Za-z]{2,5})/. A failed split teaches it
//      "OBARA", which it injects into the NEXT extraction's prompt — the
//      failure reinforces itself.
//   2. orders/[id].js writes line.partNumber verbatim into
//      item_customer_parts.customer_part_number, burning the whole sentence in
//      as a permanent lookup key.
//
// This runs after normalisation and repairs the line deterministically, so the
// result is auditable and re-runnable rather than a coin-flip on model mood.
//
// SCOPE: this recovers the CODE. It deliberately does not try to produce the
// canonical description ("SHANK") — that is master data. Once partNumber
// resolves against item_master the canonical name comes from there; inventing
// it by string surgery means re-deriving a stop-list for every new OEM prefix.

// A part code: alphanumeric groups joined by hyphens/slashes, containing at
// least one digit and at least one separator (TWS-092-90-2, X-HD0420-3,
// TNA-16-04-10-1, 403S0K2652 is deliberately NOT matched here — see below).
const HYPHENATED_CODE = /^[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)+$/;

// A solid alphanumeric code with digits and at least one letter, length >= 5
// (403S0K2652, PLTB000004). Looser, so it is only used when no hyphenated
// candidate exists.
const SOLID_CODE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{5,}$/;

const isCodeToken = (t) => HYPHENATED_CODE.test(t) || SOLID_CODE.test(t);

// Tokens that are never a part code even though they look codey.
const NEVER_CODE = new Set(["NOS", "PCS", "EACH", "SET", "KG", "MM", "NO"]);

// Default noise words — deliberately MINIMAL. It is tempting to strip
// "ASSY"/"FIXED"/"MOV." as boilerplate, but this tenant's item master
// distinguishes "SHUNT" from "SHUNT ASSY" and "FIXED HOLDER" from
// "MOV. HOLDER" — they are different items, so dropping those tokens destroys
// real information. Only a grade marker is stripped by default.
// Tenant-specific additions belong in customer_format_profiles, not here.
const DEFAULT_STOP_WORDS = new Set(["STD"]);

const tokenize = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);

// Public: does this value look like a bare part code (vs a sentence)?
export const looksLikePartCode = (v) => {
  const t = tokenize(v);
  return t.length === 1 && isCodeToken(t[0]) && !NEVER_CODE.has(t[0].toUpperCase());
};

// Public: pull the part code out of a description phrase. Returns
// { partNumber, description } or null when no code token is present.
//
// Strategy: prefer the LAST code-shaped token (part codes trail the
// descriptive phrase in every observed OEM layout), then strip the code and
// the configured stop-words to leave a human description.
export const splitPartFromDescription = (text, opts = {}) => {
  const stop = opts.stopWords instanceof Set
    ? opts.stopWords
    : new Set([...DEFAULT_STOP_WORDS, ...(opts.stopWords || []).map((w) => String(w).toUpperCase())]);
  const brand = new Set((opts.brandTokens || []).map((w) => String(w).toUpperCase()));

  const tokens = tokenize(text);
  if (tokens.length < 2) return null;

  let idx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (NEVER_CODE.has(t.toUpperCase())) continue;
    if (isCodeToken(t)) { idx = i; break; }
  }
  if (idx < 0) return null;

  const partNumber = tokens[idx];
  const rest = tokens.filter((_t, i) => i !== idx);
  const description = rest
    .filter((t) => {
      const u = t.replace(/[.,]$/, "").toUpperCase();
      return !stop.has(u) && !brand.has(u);
    })
    .join(" ")
    .trim();

  return { partNumber, description: description || null };
};

// Public: repair one normalized line in place-ish (returns a new object).
// Only acts when partNumber is missing or is clearly not a bare code, so a
// line the model already split correctly is left untouched.
export const repairLinePartCode = (line, opts = {}) => {
  if (!line || typeof line !== "object") return line;
  const current = line.partNumber;
  if (current != null && looksLikePartCode(current)) return line;

  // Prefer the verbatim cell; fall back to whatever the model left behind.
  const source = line.raw_description || (typeof current === "string" ? current : null) || line.description;
  const split = splitPartFromDescription(source, opts);
  if (!split) return line;

  return {
    ...line,
    partNumber: split.partNumber,
    // Keep the model's description when we could not derive a cleaner one.
    description: split.description || line.description || null,
    _part_split: {
      via: current == null ? "missing_part_number" : "part_number_was_phrase",
      source: line.raw_description ? "raw_description" : "description",
      before: current ?? null,
    },
  };
};

// Public: repair every line on a normalized extraction. Returns
// { normalized, repaired } — `repaired` is the count, for the run event.
export const repairPartCodes = (normalized, opts = {}) => {
  if (!normalized || !Array.isArray(normalized.lines)) return { normalized, repaired: 0 };
  let repaired = 0;
  const lines = normalized.lines.map((l) => {
    const out = repairLinePartCode(l, opts);
    if (out !== l && out?._part_split) repaired++;
    return out;
  });
  return { normalized: { ...normalized, lines }, repaired };
};

export const __test__ = { DEFAULT_STOP_WORDS, isCodeToken };
