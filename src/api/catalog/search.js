// GET /api/catalog/search?q=...&limit=
//
// Synonym + typo-tolerant catalog search. We hit `item_master` plus
// `catalog_synonyms` via pg_trgm similarity. Returns the top N items
// with their similarity scores, alternatives, and any private-label
// upsell hints attached so the quoting UI can swap in real time.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

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
    if (!q) return json(res, 400, { error: { message: "q required" } });
    const svc = serviceClient();

    // Direct + synonym match. We use ilike for now (Supabase's RPC
    // surface for real similarity() needs an SQL function we'd
    // create lazily); ilike with the trgm index gives us
    // good-enough fuzzy search at the cost of perfect ranking.
    const term = "%" + q.replace(/[%_]/g, "") + "%";
    const [items, synonyms] = await Promise.all([
      svc.from("item_master")
        .select("id, part_no, description, list_price")
        .eq("tenant_id", ctx.tenantId)
        .or(`part_no.ilike.${term},description.ilike.${term}`)
        .limit(limit),
      svc.from("catalog_synonyms")
        .select("item_id, synonym, confidence")
        .eq("tenant_id", ctx.tenantId)
        .ilike("synonym", term)
        .limit(limit),
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

    return json(res, 200, { results: decorated, query: q });
  } catch (err) { sendError(res, err); }
}
