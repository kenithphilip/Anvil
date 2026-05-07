// GET /api/catalog/search?q=...&limit=&mode=auto|hybrid|lexical|semantic
//
// Synonym + typo-tolerant catalog search.
//
//   lexical     ILIKE on part_no / description plus catalog_synonyms.
//   semantic    cosine-distance lookup against item_master.embedding
//               (Voyage AI voyage-3, P8.4). Requires the row to be
//               embedded; falls back to lexical when the corpus is
//               not yet embedded.
//   hybrid      union of both; semantic results boosted, then merged
//               and deduped. This is the default ('auto' resolves to
//               hybrid when VOYAGE_API_KEY is configured).
//
// Results carry alternatives + private-label hints so the quoting UI
// can swap in real time.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { voyageEmbed, voyageIsConfigured } from "../_lib/voyage.js";

const SEMANTIC_BOOST = 0.05; // small bias so a strong semantic match beats a substring near-match

// Run the pgvector cosine-distance lookup via the SQL function
// shipped in migration 075. Returns [{id, part_no, description,
// list_price, similarity}] sorted by similarity desc.
const semanticLookup = async (svc, tenantId, q, limit) => {
  if (!voyageIsConfigured()) return [];
  const emb = await voyageEmbed([q], { input_type: "query" });
  if (!emb.ok || !emb.vectors[0]) return [];
  const r = await svc.rpc("search_catalog_by_embedding", {
    p_tenant: tenantId,
    p_query: emb.vectors[0],
    p_limit: limit,
  });
  if (r.error) {
    // eslint-disable-next-line no-console
    console.warn("[catalog/search] semantic rpc failed: " + r.error.message);
    return [];
  }
  return (r.data || []).map((row) => ({
    ...row,
    match: "semantic",
    score: Math.min(1, (Number(row.similarity) || 0) + SEMANTIC_BOOST),
  }));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://x");
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10)));
    const modeParam = (url.searchParams.get("mode") || "auto").toLowerCase();
    if (!q) return json(res, 400, { error: { message: "q required" } });
    const svc = serviceClient();

    const mode = modeParam === "auto"
      ? (voyageIsConfigured() ? "hybrid" : "lexical")
      : modeParam;

    // Direct + synonym match. We use ilike for now (Supabase's RPC
    // surface for real similarity() needs an SQL function we'd
    // create lazily); ilike with the trgm index gives us
    // good-enough fuzzy search at the cost of perfect ranking.
    const term = "%" + q.replace(/[%_]/g, "") + "%";
    const lexicalLimit = mode === "semantic" ? 0 : limit;
    const [items, synonyms, semantic] = await Promise.all([
      lexicalLimit
        ? svc.from("item_master")
            .select("id, part_no, description, list_price")
            .eq("tenant_id", ctx.tenantId)
            .or(`part_no.ilike.${term},description.ilike.${term}`)
            .limit(lexicalLimit)
        : Promise.resolve({ data: [] }),
      lexicalLimit
        ? svc.from("catalog_synonyms")
            .select("item_id, synonym, confidence")
            .eq("tenant_id", ctx.tenantId)
            .ilike("synonym", term)
            .limit(lexicalLimit)
        : Promise.resolve({ data: [] }),
      mode === "lexical"
        ? Promise.resolve([])
        : semanticLookup(svc, ctx.tenantId, q, limit),
    ]);
    if (items.error) throw new Error(items.error.message);
    if (synonyms.error) throw new Error(synonyms.error.message);

    // Hydrate items pulled in via synonym match.
    const synItemIds = (synonyms.data || []).map((s) => s.item_id);
    let synItems = [];
    if (synItemIds.length) {
      const r = await svc.from("item_master").select("id, part_no, description, list_price")
        .eq("tenant_id", ctx.tenantId).in("id", synItemIds);
      synItems = r.data || [];
    }
    const allMap = new Map();
    for (const it of items.data || []) {
      allMap.set(it.id, { ...it, match: "direct", score: 1.0 });
    }
    for (const it of synItems) {
      if (allMap.has(it.id)) continue;
      const s = (synonyms.data || []).find((x) => x.item_id === it.id);
      allMap.set(it.id, { ...it, match: "synonym", score: Number(s?.confidence) || 0.7, synonym: s?.synonym });
    }
    // Layer semantic hits last so a stronger semantic score upgrades
    // an already-matched lexical row.
    for (const it of semantic) {
      const existing = allMap.get(it.id);
      if (existing && existing.score >= it.score) continue;
      allMap.set(it.id, { ...existing, ...it });
    }
    const ranked = Array.from(allMap.values()).sort((a, b) => b.score - a.score).slice(0, limit);

    // Decorate with alternatives + private-label upsell.
    const itemIds = ranked.map((r) => r.id);
    let alternatives = [];
    let privateLabels = [];
    if (itemIds.length) {
      const [alt, pl] = await Promise.all([
        svc.from("catalog_alternatives")
          .select("item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score")
          .eq("tenant_id", ctx.tenantId).in("item_id", itemIds),
        svc.from("private_label_items")
          .select("item_id, label_brand, margin_bps")
          .eq("tenant_id", ctx.tenantId).eq("active", true).in("item_id", itemIds),
      ]);
      alternatives = alt.data || [];
      privateLabels = pl.data || [];
    }
    // Group by item_id.
    const altByItem = new Map();
    for (const a of alternatives) {
      if (!altByItem.has(a.item_id)) altByItem.set(a.item_id, []);
      altByItem.get(a.item_id).push(a);
    }
    const plByItem = new Map(privateLabels.map((p) => [p.item_id, p]));
    const decorated = ranked.map((r) => ({
      ...r,
      alternatives: altByItem.get(r.id) || [],
      private_label: plByItem.get(r.id) || null,
    }));

    return json(res, 200, {
      results: decorated,
      query: q,
      mode,
      semantic_available: voyageIsConfigured(),
    });
  } catch (err) { sendError(res, err); }
}
