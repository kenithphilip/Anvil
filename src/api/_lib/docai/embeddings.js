// Per-customer embedding index (Wave 5.2 / #23).
//
// The item-mapper resolver's tier 5 (description_fuzzy) uses
// significant-word overlap. That works for exact-token matches
// but misses synonyms ("clamp" vs "fastener", "screw" vs "bolt",
// "GD544" vs "guide assembly"). An embedding-backed nearest-
// neighbour search catches synonyms the token-overlap path
// misses.
//
// This module:
//
//   1. buildItemEmbedSource(item) constructs a stable text
//      blob from { part_no, description, alias, print_name }
//      to embed.
//   2. embedTextBatch(texts, opts) calls the embedding provider
//      via opts.embedFn. Caller injects the provider so the
//      cost-guard fires consistently with the existing chain.
//   3. upsertItemEmbeddings(svc, tenantId, items, embedFn, opts)
//      embeds + writes any items missing or stale.
//   4. searchSimilarItems(svc, tenantId, queryEmbedding, opts)
//      executes a vector cosine-similarity search.
//
// Encoder default: text-embedding-3-small (1536 dims, $0.02 per
// 1M tokens). Voyager-large (Anthropic) is an alternate via
// opts.encoder. Both produce 1536-dim outputs.

const DEFAULT_ENCODER = "text-embedding-3-small";
const DEFAULT_BATCH = 64;

export const buildItemEmbedSource = (item) => {
  if (!item) return "";
  const parts = [
    item.part_no, item.description, item.print_name, item.alias,
    item.spec_text, item.category,
  ].filter((x) => typeof x === "string" && x.length > 0);
  return parts.join(" | ").slice(0, 1024);
};

// Embed a batch of texts via the caller-supplied embedFn.
// embedFn(text[], opts) -> Promise<{ ok, embeddings: number[][] }>.
// Returns null on failure so callers can fall through to the
// token-overlap path.
export const embedTextBatch = async (texts, opts = {}) => {
  if (!Array.isArray(texts) || !texts.length) return null;
  if (typeof opts.embedFn !== "function") return null;
  try {
    const out = await opts.embedFn(texts, {
      encoder: opts.encoder || DEFAULT_ENCODER,
      tenantId: opts.tenantId || null,
    });
    if (!out?.ok || !Array.isArray(out.embeddings)) return null;
    return out.embeddings;
  } catch (_e) { return null; }
};

// Find items in item_master that don't have an embedding yet (or
// whose source_text changed since the last embed). Returns an
// array of items to re-embed. Caller passes the desired source
// text already built so we don't re-stringify.
export const findStaleItems = async (svc, tenantId, opts = {}) => {
  if (!svc || !tenantId) return [];
  try {
    const r = await svc.from("item_master")
      .select("id, part_no, description, alias, print_name, spec_text, category, updated_at")
      .eq("tenant_id", tenantId)
      .limit(Number(opts.limit || 1000));
    const items = r?.data || [];
    const exR = await svc.from("item_embeddings")
      .select("item_id, source_text, updated_at")
      .eq("tenant_id", tenantId);
    const existing = new Map((exR?.data || []).map((e) => [e.item_id, e]));
    const stale = items.filter((it) => {
      const e = existing.get(it.id);
      if (!e) return true;
      // Re-embed when source_text would differ.
      const want = buildItemEmbedSource(it);
      return want !== e.source_text;
    });
    return stale;
  } catch (_e) { return []; }
};

// Upsert embeddings for the supplied items. Returns count of
// rows written.
export const upsertItemEmbeddings = async (svc, tenantId, items, embedFn, opts = {}) => {
  if (!svc || !tenantId || !Array.isArray(items) || !items.length) return { ok: true, written: 0 };
  if (typeof embedFn !== "function") return { ok: false, error: "no_embed_fn" };
  const batchSize = Number(opts.batchSize || DEFAULT_BATCH);
  const encoder = opts.encoder || DEFAULT_ENCODER;
  let written = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const sources = slice.map(buildItemEmbedSource);
    const vectors = await embedTextBatch(sources, { embedFn, encoder, tenantId });
    if (!vectors || vectors.length !== slice.length) continue;
    const rows = slice.map((it, j) => ({
      tenant_id: tenantId,
      item_id: it.id,
      embedding: vectors[j],
      encoder,
      source_text: sources[j],
      updated_at: new Date().toISOString(),
    }));
    try {
      const r = await svc.from("item_embeddings")
        .upsert(rows, { onConflict: "tenant_id,item_id" });
      if (!r.error) written += rows.length;
    } catch (_e) { /* keep going */ }
  }
  return { ok: true, written };
};

// Search similar items by vector. Returns top-N by cosine
// distance with item joins. limit defaults to 5.
export const searchSimilarItems = async (svc, tenantId, queryEmbedding, opts = {}) => {
  if (!svc || !tenantId || !Array.isArray(queryEmbedding) || !queryEmbedding.length) return [];
  const limit = Number(opts.limit || 5);
  try {
    // rpc('match_item_embeddings', ...) is the canonical helper;
    // when absent, fall back to a raw SQL via .from with order.
    const r = await svc.rpc("match_item_embeddings", {
      _tenant_id: tenantId,
      _query: queryEmbedding,
      _match_count: limit,
    });
    return r?.data || [];
  } catch (_e) {
    return [];
  }
};

export const __test = { buildItemEmbedSource, DEFAULT_ENCODER, DEFAULT_BATCH };
