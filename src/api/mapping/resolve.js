// POST /api/mapping/resolve
//
// One-call mapping API. Wave CM 5.2.
//
// The single entry point every caller uses to resolve PO lines
// to canonical item_master rows. Wraps the full mapping
// pipeline:
//
//   1. Resolver tier ladder (item-mapper.js) using
//      mapLinesToItemMaster with the new fuzzy_blocked tier.
//   2. For lines still unmapped after the deterministic ladder,
//      hybrid BM25 + vector retrieval (Wave CM 2.2) to fetch
//      candidate item_master rows.
//   3. Cross-encoder rerank (Wave CM 2.3) to score the
//      candidates and return top-3 suggestions per line.
//   4. Returns the enriched lines with mapping decisions +
//      suggestions for operator review.
//
// Request body:
//   {
//     customer_id: uuid,
//     lines: [{ partNumber, description, ... }],
//     context?: 'sales_order' | 'quote' | 'rfq' | 'internal_so',
//     contact_id?: uuid,                 // for CM 3.3 priming
//     rerank?: boolean (default true)
//   }
//
// Response:
//   {
//     ok: true,
//     resolved_lines: [<line with _mapped_item>],
//     suggestions: [{
//       line_index,
//       candidates: [{ item_id, part_no, description, score,
//                      reason }]
//     }]
//   }
//
// Cost guard / cost cap / prompt caching all fire naturally
// because the rerank call goes through callAnthropic.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { mapLinesToItemMaster } from "../_lib/item-mapper.js";
import { searchItemsHybrid, buildSearchText } from "../_lib/hybrid-item-search.js";
import { rerankCandidates } from "../_lib/cross-encoder-rerank.js";
import { callAnthropic } from "../_lib/anthropic.js";

const DEFAULT_TOP_K = 3;
const MAX_LINES = 200;

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") throw httpError(405, "method_not_allowed");
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    let body;
    try { body = await readBody(req); } catch (_e) { throw httpError(400, "bad_body"); }
    const customerId = body?.customer_id || null;
    const lines = Array.isArray(body?.lines) ? body.lines.slice(0, MAX_LINES) : null;
    const context = typeof body?.context === "string" ? body.context : "sales_order";
    const contactId = body?.contact_id || null;
    const rerankFlag = body?.rerank !== false;
    if (!lines || !lines.length) throw httpError(400, "lines_required");
    const svc = serviceClient();

  // 1. Run the deterministic resolver chain. Lines that resolve
  //    via tier 1-5 get _mapped_item; the rest carry _mapped_item=null.
  let resolved;
  try {
    resolved = await mapLinesToItemMaster(svc, ctx.tenantId, customerId, lines, { context });
  } catch (err) {
    return sendError(res, 500, "resolver_failed: " + (err?.message || err));
  }
  // 2. For unmapped lines, run hybrid retrieval to fetch
  //    candidates. We skip the embedding half (no embedFn
  //    injection here yet; that lands with the embedding
  //    provider plumbing). Pure lexical works as the first cut.
  const unmappedIndices = [];
  resolved.forEach((ln, i) => { if (!ln._mapped_item) unmappedIndices.push(i); });
  const suggestions = [];
  if (rerankFlag && unmappedIndices.length) {
    for (const i of unmappedIndices) {
      const line = resolved[i];
      const queryText = buildSearchText(line);
      if (!queryText) continue;
      const candidates = await searchItemsHybrid(svc, {
        tenantId: ctx.tenantId,
        queryText,
        queryEmbedding: null,        // embedding plumbing deferred
        matchCount: 10,
      });
      if (!candidates.length) continue;
      // Pass through the cross-encoder rerank.
      const reranked = await rerankCandidates({
        line,
        candidates,
        callAnthropic,
        opts: { tenantId: ctx.tenantId, topK: DEFAULT_TOP_K },
      });
      if (reranked && reranked.length) {
        suggestions.push({ line_index: i, candidates: reranked });
      } else {
        // Fall back to the pre-rerank order if the rerank
        // failed; still useful to the operator.
        suggestions.push({ line_index: i, candidates: candidates.slice(0, DEFAULT_TOP_K) });
      }
    }
  }
    return json(res, 200, {
      ok: true,
      resolved_lines: resolved,
      suggestions,
      meta: {
        total_lines: lines.length,
        mapped_lines: lines.length - unmappedIndices.length,
        unmapped_lines: unmappedIndices.length,
        suggestions_emitted: suggestions.length,
        context,
        contact_id: contactId,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
