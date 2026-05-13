// Hybrid BM25 + vector item search (Wave CM 2.2).
//
// Wraps the SQL function match_items_hybrid() (migration 131).
// Caller supplies a query string (lexical) and optionally a
// query embedding (semantic). Returns the top-K candidates by
// reciprocal rank fusion of the two retrievers.
//
// Use-case: when the resolver's cheap tiers (customer_part,
// part_no exact, alias, fuzzy_blocked) miss, this stage is the
// next-best-effort before the LLM rerank (Wave CM 2.3). It's
// cheap (one SQL call, two index scans, fusion in-DB) and
// catches both the "exact part-no token present in description"
// case (lexical) and the "semantic synonym" case (vector).

const DEFAULT_MATCH_COUNT = 10;
const DEFAULT_CANDIDATES_PER_RETRIEVER = 40;

// Build the lexical query from a PO line. We concatenate the
// part-number-ish candidates + the description so the tsvector
// query has a chance to match any of the available signals.
export const buildSearchText = (line) => {
  if (!line) return "";
  const fields = [
    line.partNumber, line.partNo, line.itemCode, line.sku, line.code,
    line.customer_part_number, line.description, line.name, line.item,
  ].filter((x) => typeof x === "string" && x.trim().length > 0);
  if (!fields.length) return "";
  return fields.join(" ").trim().slice(0, 256);
};

// Public: run the hybrid search for one line.
//
// Returns: [{ item_id, part_no, description, score, bm25_rank,
// vector_rank }] sorted by score desc. Empty array when the
// RPC is unavailable or returns nothing.
//
// queryEmbedding may be null when caller has no embedding
// available; the RPC then runs the lexical half only.
export const searchItemsHybrid = async (svc, { tenantId, queryText, queryEmbedding, matchCount, candidatesPerRetriever } = {}) => {
  if (!svc || !tenantId) return [];
  if ((!queryText || queryText.trim().length === 0) && !Array.isArray(queryEmbedding)) {
    return [];
  }
  try {
    const r = await svc.rpc("match_items_hybrid", {
      _tenant_id: tenantId,
      _query_text: queryText || "",
      _query_vector: Array.isArray(queryEmbedding) ? queryEmbedding : null,
      _match_count: Number(matchCount) || DEFAULT_MATCH_COUNT,
      _candidates_per_retriever: Number(candidatesPerRetriever) || DEFAULT_CANDIDATES_PER_RETRIEVER,
    });
    return r?.data || [];
  } catch (_e) {
    return [];
  }
};

// Convenience for the batch case: given an array of lines and a
// function to embed each line's search text, return per-line
// hybrid candidates. The embedFn is injected so the caller's
// cost-guard + prompt-caching fire normally.
export const searchItemsHybridBatch = async (svc, { tenantId, lines, embedFn, matchCount } = {}) => {
  if (!Array.isArray(lines) || !lines.length) return [];
  const texts = lines.map(buildSearchText);
  let vectors = new Array(lines.length).fill(null);
  if (typeof embedFn === "function") {
    try {
      const nonEmpty = texts.map((t, i) => ({ t, i })).filter((x) => x.t.length > 0);
      if (nonEmpty.length) {
        const out = await embedFn(nonEmpty.map((x) => x.t), { tenantId });
        if (out?.ok && Array.isArray(out.embeddings)) {
          for (let k = 0; k < nonEmpty.length; k++) {
            vectors[nonEmpty[k].i] = out.embeddings[k] || null;
          }
        }
      }
    } catch (_e) { /* fall through to lexical-only */ }
  }
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const out = await searchItemsHybrid(svc, {
      tenantId,
      queryText: texts[i],
      queryEmbedding: vectors[i],
      matchCount,
    });
    results.push(out);
  }
  return results;
};

export const __test = { DEFAULT_MATCH_COUNT, DEFAULT_CANDIDATES_PER_RETRIEVER };
