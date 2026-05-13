// Cross-encoder rerank stage (Wave CM 2.3).
//
// The retrieval-then-rerank pattern is the standard playbook
// (Sentence Transformers docs, hackerllama 2026 write-up):
//   1. Fast retrieval (bi-encoder + BM25, Wave CM 2.2) pulls a
//      candidate set of 20-100 items.
//   2. Slow + accurate rerank scores every (query, candidate)
//      pair jointly, returning the top-K with high confidence.
//
// Cross-encoder rerank is "slow" relative to vector search but
// trivially cheap relative to a full LLM extraction. One call
// per line, prompt-cached, with structured tool output. For a
// 20-line PO, total cost is ~$0.005 with Claude Haiku.
//
// This module:
//   1. Builds a compact prompt with the query line + every
//      candidate, asks the model to score each on a 0-100 scale
//      with a one-sentence reason.
//   2. Validates the response: every candidate must map back to
//      an item in the input set; no hallucinated IDs.
//   3. Returns the top-K reranked by the model's scores.
//
// The caller injects callAnthropic (or a callOpenAI / callGemini
// equivalent in future) so the existing cost-guard, prompt-
// cache, and per-tenant budget all fire uniformly.

const RERANK_SYSTEM_PROMPT = `You are an item-mapping reranker. The user supplies one PO line
plus a small list of candidate items from the tenant's master.
Score how well each candidate matches the line on a 0-100 scale.

Scoring rubric:
  100  the candidate IS the canonical for this line (typo or
       synonym only; quantities + UOM compatible).
   85  the candidate is very likely correct; slight wording
       difference or a known abbreviation.
   60  plausible; descriptions overlap but at least one signal
       (HSN, UOM, part-no family) disagrees.
   30  weak; one shared word but different part family.
    5  no shared signal.

Return one row per candidate with score (0-100) and a short
reason (under 80 chars). Order does not matter; the caller
sorts by score.`;

const RERANK_TOOL = {
  name: "score_candidates",
  description: "Score each candidate against the query line.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item_id: { type: "string" },
            score: { type: "number" },
            reason: { type: "string" },
          },
          required: ["item_id", "score"],
        },
      },
    },
    required: ["scores"],
  },
};

const MAX_CANDIDATES = 12;
const MAX_DESC_CHARS = 160;

const trim = (s, n) => {
  if (s == null) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
};

// Build the user prompt for one line. Compact: each candidate
// is one line; we cap descriptions so the model focuses on
// signal rather than wading through hundreds of chars.
export const buildRerankPrompt = (line, candidates) => {
  const lineText = [
    "QUERY LINE:",
    "  partNumber: " + trim(line?.partNumber || line?.partNo || "", 80),
    "  description: " + trim(line?.description || line?.name || "", MAX_DESC_CHARS),
    line?.hsn ? "  hsn: " + trim(line.hsn, 16) : null,
    line?.uom ? "  uom: " + trim(line.uom, 16) : null,
  ].filter(Boolean).join("\n");
  const cands = candidates.slice(0, MAX_CANDIDATES).map((c, i) => {
    const id = c.item_id || c.id || ("cand" + i);
    return [
      "  [" + id + "]",
      "    part_no: " + trim(c.part_no || c.partNo || "", 80),
      "    description: " + trim(c.description || c.print_name || c.alias || "", MAX_DESC_CHARS),
      c.hsn_sac ? "    hsn: " + trim(c.hsn_sac, 16) : null,
      c.uom ? "    uom: " + trim(c.uom, 16) : null,
    ].filter(Boolean).join("\n");
  }).join("\n");
  return lineText + "\n\nCANDIDATES:\n" + cands;
};

// Public: rerank candidates for one PO line. Returns the top-K
// reranked by the model with the model's score (0-100) and
// reason attached. K defaults to 3.
//
// Returns null when callAnthropic is missing or upstream fails.
// The caller falls back to the pre-rerank ordering.
export const rerankCandidates = async ({
  line, candidates, callAnthropic, opts = {},
}) => {
  if (!line || !Array.isArray(candidates) || !candidates.length) return null;
  if (typeof callAnthropic !== "function") return null;
  const limited = candidates.slice(0, MAX_CANDIDATES);
  const validIds = new Set(limited.map((c) => String(c.item_id || c.id)));
  const result = await callAnthropic({
    tenantId: opts.tenantId || null,
    purpose: "item_rerank",
    model: opts.model || "claude-3-5-haiku-latest",
    max_tokens: 1200,
    system: [{ type: "text", text: RERANK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: buildRerankPrompt(line, limited) }] }],
    tools: [RERANK_TOOL],
    tool_choice: { type: "tool", name: "score_candidates" },
    temperature: 0,
  });
  if (!result?.ok) return null;
  const block = (result.data?.content || []).find((c) => c.type === "tool_use" && c.name === "score_candidates");
  if (!block) return null;
  const scoresIn = Array.isArray(block.input?.scores) ? block.input.scores : [];
  // Validate + clamp. Drop hallucinated ids. Map score to 0..1
  // for the caller's convenience.
  const enriched = [];
  for (const s of scoresIn) {
    const id = String(s?.item_id || "");
    if (!validIds.has(id)) continue;
    const raw = Number(s?.score);
    const score01 = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0;
    const cand = limited.find((c) => String(c.item_id || c.id) === id);
    enriched.push({
      ...cand,
      rerank_score: score01,
      rerank_reason: typeof s?.reason === "string" ? s.reason.slice(0, 200) : null,
    });
  }
  enriched.sort((a, b) => b.rerank_score - a.rerank_score);
  const topK = Number(opts.topK) || 3;
  return enriched.slice(0, topK);
};

export const __test = { MAX_CANDIDATES, MAX_DESC_CHARS, RERANK_TOOL };
