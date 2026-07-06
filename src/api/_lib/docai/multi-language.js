// Multi-language line items + translation (Wave 2.4 / #5).
//
// Northwind's pilot tenants are mostly Indian B2B but Meridian POs
// land with the supplier-side block in Korean (Hangul), Tally
// vouchers from Tamil-Nadu shops often carry Tamil descriptions
// on top of the English line items, German engineering POs use
// "Stueckzahl" / "Menge" / "Bezeichnung" instead of "Qty" /
// "Description", and Japanese suppliers send POs in mixed Kanji
// + romaji. Today the extractor treats everything as English; non-
// English line descriptions land in normalized.lines[].description
// verbatim, which:
//
//   1. Breaks fuzzy matching against item_master.description
//      (the resolver normalises to ASCII and dies on Hangul /
//      Devanagari / Kanji).
//   2. Confuses operators who skim the recon table looking for
//      English keywords.
//   3. Makes per-customer line-pattern learning (Wave 1.5)
//      surface tokens like "주문" that match nothing.
//
// This module:
//
//   1. Detects the dominant script(s) in a normalized extraction
//      output: latin, devanagari, hangul, hiragana, kanji, arabic,
//      cyrillic, tamil, bengali, gujarati, thai, hebrew. Counts
//      glyphs per script, returns the top-2 with weights.
//
//   2. Annotates each line with detected_languages: [...] and a
//      needs_translation boolean so the UI can render a "Translate"
//      affordance.
//
//   3. Translates non-English description / part_no fields when
//      the tenant has docai_auto_translate=true. Translation
//      happens via the existing Claude / Gemini adapter (cheap
//      per-line LLM call, prompt-cached). The original text is
//      preserved on each line as description_original /
//      partNumber_original so the audit trail is lossless.
//
// Scope: this wave does the DETECTION + ANNOTATION end-to-end.
// LLM translation is wired but gated on a tenant flag (default
// off) and the prompt is small; turning it on is a tenant_settings
// toggle.

const SCRIPT_RANGES = [
  // [name, lower-codepoint, upper-codepoint]
  // Cover the blocks that actually appear in POs we have seen.
  ["latin",       0x0021, 0x007E],
  ["latin_ext",   0x00A0, 0x024F],
  ["cyrillic",    0x0400, 0x04FF],
  ["armenian",    0x0530, 0x058F],
  ["hebrew",      0x0590, 0x05FF],
  ["arabic",      0x0600, 0x06FF],
  ["devanagari",  0x0900, 0x097F],
  ["bengali",     0x0980, 0x09FF],
  ["gujarati",    0x0A80, 0x0AFF],
  ["tamil",       0x0B80, 0x0BFF],
  ["telugu",      0x0C00, 0x0C7F],
  ["kannada",     0x0C80, 0x0CFF],
  ["malayalam",   0x0D00, 0x0D7F],
  ["thai",        0x0E00, 0x0E7F],
  ["hangul",      0xAC00, 0xD7AF],
  ["hangul_jamo", 0x1100, 0x11FF],
  ["hiragana",    0x3040, 0x309F],
  ["katakana",    0x30A0, 0x30FF],
  ["kanji",       0x4E00, 0x9FFF],
];

const isWhitespaceCp = (cp) => cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D;
const isDigitCp = (cp) => cp >= 0x30 && cp <= 0x39;

const classifyCp = (cp) => {
  if (isWhitespaceCp(cp) || isDigitCp(cp)) return null;
  for (const [name, lo, hi] of SCRIPT_RANGES) {
    if (cp >= lo && cp <= hi) return name;
  }
  return null;
};

// Public: count script frequency over a string. Returns an
// object { script_name: count, ... } skipping digits + whitespace.
export const scriptHistogram = (text) => {
  const hist = {};
  if (!text || typeof text !== "string") return hist;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp == null) continue;
    if (cp > 0xFFFF) i++; // surrogate pair
    const name = classifyCp(cp);
    if (!name) continue;
    hist[name] = (hist[name] || 0) + 1;
  }
  return hist;
};

// Reduce the histogram to a ranked list of (script, weight) and
// the dominant script (highest count). When latin + a non-latin
// script both pass the threshold we return both so the caller can
// see the mixed-language signal.
const SECONDARY_RATIO = 0.10;
export const dominantScripts = (hist) => {
  const entries = Object.entries(hist || {});
  if (!entries.length) return { dominant: null, all: [] };
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const sorted = entries
    .map(([name, n]) => ({ script: name, count: n, share: n / total }))
    .sort((a, b) => b.count - a.count);
  const top = sorted[0];
  const significant = sorted.filter((x) => x.share >= SECONDARY_RATIO);
  return { dominant: top.script, all: significant };
};

// Per-line detection. Pulls description / partNumber / customer
// part fields out of one line and returns { detected_languages:
// [{script, share}], needs_translation: bool }.
export const detectLineLanguages = (line) => {
  if (!line) return { detected_languages: [], needs_translation: false };
  const fields = [line.description, line.partNumber, line.itemCode, line.customer_part_number]
    .filter((s) => typeof s === "string" && s.trim().length > 0);
  if (!fields.length) return { detected_languages: [], needs_translation: false };
  const hist = scriptHistogram(fields.join(" "));
  const { all } = dominantScripts(hist);
  const isEnglishOnly = all.length === 1 && (all[0].script === "latin" || all[0].script === "latin_ext");
  return {
    detected_languages: all,
    needs_translation: !isEnglishOnly && all.some((x) => x.script !== "latin" && x.script !== "latin_ext"),
  };
};

// Sweep the normalized.lines array, attach detected_languages +
// needs_translation per line, and return a summary the dispatcher
// can stamp on the run.
export const annotateLineLanguages = (normalized) => {
  if (!normalized || !Array.isArray(normalized.lines)) {
    return { lines_annotated: 0, lines_needing_translation: 0, scripts_seen: [] };
  }
  const seenScripts = new Set();
  let needs = 0;
  for (const line of normalized.lines) {
    const det = detectLineLanguages(line);
    if (det.detected_languages.length) {
      line.detected_languages = det.detected_languages;
      line.needs_translation = det.needs_translation;
      if (det.needs_translation) needs++;
      for (const s of det.detected_languages) seenScripts.add(s.script);
    }
  }
  return {
    lines_annotated: normalized.lines.length,
    lines_needing_translation: needs,
    scripts_seen: Array.from(seenScripts),
  };
};

// LLM-backed translation. Takes a batch of { id, text } items and
// returns { id: translation } using a single Claude / Gemini
// call. Caller picks which adapter via opts.adapter; we don't
// configure a default here so the cost guard is honoured upstream.
//
// Returns null when the upstream call fails so the caller leaves
// original text intact.
export const translateBatch = async (items, opts) => {
  if (!Array.isArray(items) || !items.length) return null;
  if (typeof opts?.callAnthropic !== "function") return null;
  const targetLang = opts.targetLang || "English";
  const tool = {
    name: "return_translations",
    description: "Return the translated lines as a JSON object keyed by id.",
    input_schema: {
      type: "object",
      properties: {
        translations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["translations"],
    },
  };
  const system = "Translate each input string into " + targetLang + ". Preserve numbers, codes, units, and product names verbatim. Return one translation per input id.";
  const body = items.map((x) => "id=" + JSON.stringify(x.id) + " text=" + JSON.stringify(x.text)).join("\n");
  const r = await opts.callAnthropic({
    tenantId: opts.tenantId || null,
    purpose: "translate",
    model: opts.model || "claude-3-5-haiku-latest",
    max_tokens: 1500,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: body }] }],
    tools: [tool],
    tool_choice: { type: "tool", name: "return_translations" },
    temperature: 0,
  });
  if (!r?.ok) return null;
  const content = r.data?.content || [];
  const block = content.find((b) => b.type === "tool_use" && b.name === "return_translations");
  if (!block) return null;
  const arr = Array.isArray(block.input?.translations) ? block.input.translations : [];
  const out = {};
  for (const t of arr) {
    if (t?.id && typeof t.text === "string") out[t.id] = t.text;
  }
  return out;
};

export const __test = { classifyCp, SECONDARY_RATIO };
