// Layer C: AI-assisted item-mapping suggestion.
//
// The resolver in src/api/_lib/item-mapper.js handles five tiers
// of deterministic resolution (customer_part / item_master.part_no
// / specification_code / alias / description_fuzzy). Many PO lines
// still come back unmapped because the customer uses a coded
// reference and a description we have no signal on (Hyundai PO
// item GD544202603190008 with description "GUIDE ASSY" where the
// tenant master happens to call it "Guide Assembly THB-L1-70B-2").
//
// This helper takes those unmapped lines, fetches a small set of
// candidate item_master rows per line via Postgres ILIKE on the
// significant words, and asks Claude which (if any) candidate is
// the right match. Returns top-3 suggestions per line with a
// confidence score the operator confirms (or rejects) on the
// recon table. Accepted suggestions ride through the existing
// Layer A write-back path with match_via:"llm_suggest" so the
// item_customer_parts row carries its provenance.
//
// Cost: capped at 10 lines per call. Each line is one LLM round-
// trip with ~8 candidates as context (small prompt, fast model).
// Total per call: ~10 round-trips, well under 30k tokens.

import { callAnthropic, cacheableSystem, cacheableTools } from "./anthropic.js";

const SIGNIFICANT_WORD = /[a-z0-9]{3,}/g;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "any",
  "all", "set", "one", "two", "three", "your", "our", "nos",
]);

const significantWords = (text) => {
  if (!text) return [];
  const matches = String(text).toLowerCase().match(SIGNIFICANT_WORD) || [];
  return [...new Set(matches)].filter((w) => !STOP_WORDS.has(w));
};

// Pull the line's likely canonical neighbours from item_master via
// per-word ILIKE on description / print_name / alias. We rank by
// word-overlap count so the LLM gets the densest candidates first.
export const getCandidatesForLine = async (svc, tenantId, line, opts = {}) => {
  const maxRows = Number(opts.limit || 8);
  const words = significantWords([
    line.description, line.name, line.item, line.partNumber, line.itemCode,
  ].filter(Boolean).join(" ")).slice(0, 6);
  if (!words.length) return [];

  // Issue one PostgREST query that OR's the words across the
  // three text columns. PostgREST's .or syntax requires escaping
  // commas / parens.
  const clauses = [];
  for (const w of words) {
    const safe = String(w).replace(/[%_,()*]/g, "\\$&");
    clauses.push("description.ilike.%" + safe + "%");
    clauses.push("print_name.ilike.%" + safe + "%");
    clauses.push("alias.ilike.%" + safe + "%");
  }
  const q = svc
    .from("item_master")
    .select("id, part_no, alias, description, print_name, hsn_sac, uom, source_country, gst_applicable, taxability_type, type_of_supply, rate_of_duty_pct, stock_group, specification_code")
    .eq("tenant_id", tenantId)
    .or(clauses.join(","))
    .limit(maxRows * 4);
  const r = await q;
  if (r.error || !Array.isArray(r.data)) return [];

  // Score by word-overlap count. Higher = more likely.
  const score = (row) => {
    const hay = [(row.description || ""), (row.print_name || ""), (row.alias || ""), (row.part_no || "")].join(" ").toLowerCase();
    return words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
  };
  return r.data
    .map((row) => ({ row, score: score(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRows)
    .map((x) => x.row);
};

const SYSTEM_PROMPT = [
  "You are a parts-catalogue matcher for a B2B industrial distributor.",
  "Each task gives you ONE customer PO line (part number + description) and a short list of CANDIDATE",
  "canonical items from the tenant's item master.",
  "Return 0 to 3 candidates that most likely refer to the same physical part, with a confidence score",
  "0-100. Be conservative; if no candidate is a confident match, return an empty array.",
  "Match signals you should weight:",
  "  - exact or near-exact part-number / alias / specification_code overlap",
  "  - description noun + descriptor overlap (BEND ADAPTER -> Bend Adapter)",
  "  - HSN code consistency (do not mix categories)",
  "Do NOT invent item IDs. Every item_id you return MUST come from the CANDIDATES list verbatim.",
].join("\n");

const SUGGEST_TOOL = {
  name: "return_suggestions",
  description: "Return the top 0-3 candidate matches with confidence.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            item_id: { type: "string", description: "UUID of a candidate item_master row from the CANDIDATES list." },
            confidence_pct: { type: "number", minimum: 0, maximum: 100 },
            reasoning: { type: "string", description: "One sentence explaining the match signal." },
          },
          required: ["item_id", "confidence_pct"],
        },
      },
    },
    required: ["suggestions"],
  },
};

const buildPrompt = (line, candidates) => [
  "CUSTOMER LINE",
  "  partNumber: " + JSON.stringify(line.partNumber || line.itemCode || line.sku || ""),
  "  description: " + JSON.stringify(line.description || line.name || line.item || ""),
  line.specification ? "  specification: " + JSON.stringify(line.specification) : null,
  line.hsn ? "  hsn: " + JSON.stringify(line.hsn) : null,
  "",
  "CANDIDATES (item_master rows for this tenant)",
  ...candidates.map((c, i) => (
    "  " + (i + 1) + ". id=" + c.id
    + " part_no=" + JSON.stringify(c.part_no || "")
    + (c.alias ? " alias=" + JSON.stringify(c.alias) : "")
    + (c.specification_code ? " spec=" + JSON.stringify(c.specification_code) : "")
    + " desc=" + JSON.stringify(c.description || c.print_name || "")
    + (c.hsn_sac ? " hsn=" + c.hsn_sac : "")
  )),
  "",
  "Return 0 to 3 candidates ranked by confidence. Empty array if nothing matches.",
].filter(Boolean).join("\n");

const extractToolUse = (data, toolName) => {
  if (!data || !Array.isArray(data.content)) return null;
  for (const block of data.content) {
    if (block && block.type === "tool_use" && block.name === toolName) return block.input || null;
  }
  return null;
};

// Ask the LLM for one line's suggestions, validate the response,
// and drop any item_id the model hallucinated (i.e. not in the
// candidate set).
const askLlmForLine = async (tenantId, line, candidates) => {
  if (!candidates.length) return [];
  const candidateIds = new Set(candidates.map((c) => c.id));
  const userPrompt = buildPrompt(line, candidates);
  // Phase F #24: cache the system prompt + tool schema. With 10
  // lines per batch, cache hits 9 times out of 10 calls so the
  // input-token discount compounds.
  const resp = await callAnthropic({
    tenantId,
    purpose: "extraction",
    tier: "preflight",
    max_tokens: 1500,
    temperature: 0,
    system: cacheableSystem(SYSTEM_PROMPT),
    messages: [
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ],
    tools: cacheableTools([SUGGEST_TOOL]),
    tool_choice: { type: "tool", name: SUGGEST_TOOL.name },
  });
  if (!resp || !resp.ok) return [];
  const input = extractToolUse(resp.data, SUGGEST_TOOL.name);
  if (!input || !Array.isArray(input.suggestions)) return [];
  return input.suggestions
    .filter((s) => s && s.item_id && candidateIds.has(s.item_id))
    .map((s) => ({
      item_id: s.item_id,
      confidence_pct: Math.max(0, Math.min(100, Number(s.confidence_pct) || 0)),
      reasoning: s.reasoning ? String(s.reasoning).slice(0, 240) : null,
    }))
    .slice(0, 3);
};

// Public entry point. unmappedLines may already carry an index
// (so the response is stably keyed even when the caller filtered
// the array before passing it in); we fall back to the array
// index if no explicit _line_index is set.
//
// Returns: [{
//   line_index: number,
//   suggestions: [{
//     item_id, confidence_pct, reasoning,
//     // Materialised candidate fields so the UI can render the
//     // canonical name without a second fetch.
//     part_no, alias, description, print_name, hsn_sac, uom,
//     gst_applicable, taxability_type, type_of_supply,
//     rate_of_duty_pct, stock_group, specification_code,
//   }],
// }]
export const suggestMappings = async (svc, tenantId, customerId, unmappedLines, opts = {}) => {
  const max = Number(opts.maxLines || 10);
  const lines = (unmappedLines || []).slice(0, max);
  if (!lines.length) return [];

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineIndex = Number.isInteger(line && line._line_index) ? line._line_index : i;
    const candidates = await getCandidatesForLine(svc, tenantId, line);
    if (!candidates.length) {
      out.push({ line_index: lineIndex, suggestions: [], reason: "no_candidates" });
      continue;
    }
    let suggestions = [];
    try {
      suggestions = await askLlmForLine(tenantId, line, candidates);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[item-mapper-llm] line " + lineIndex + " failed: " + (e && e.message));
      out.push({ line_index: lineIndex, suggestions: [], reason: "llm_error" });
      continue;
    }
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const hydrated = suggestions.map((s) => {
      const c = byId.get(s.item_id) || {};
      return {
        item_id: s.item_id,
        confidence_pct: s.confidence_pct,
        reasoning: s.reasoning,
        part_no: c.part_no || null,
        alias: c.alias || null,
        description: c.description || null,
        print_name: c.print_name || null,
        hsn_sac: c.hsn_sac || null,
        uom: c.uom || null,
        source_country: c.source_country || null,
        gst_applicable: c.gst_applicable || null,
        taxability_type: c.taxability_type || null,
        type_of_supply: c.type_of_supply || null,
        rate_of_duty_pct: c.rate_of_duty_pct != null ? Number(c.rate_of_duty_pct) : null,
        stock_group: c.stock_group || null,
        specification_code: c.specification_code || null,
      };
    });
    out.push({ line_index: lineIndex, suggestions: hydrated });
  }

  return out;
};

// Test seam: expose the pure helpers so a unit test can drive the
// scoring + hallucination filter without an Anthropic key.
export const __test = {
  significantWords,
  extractToolUse,
};
