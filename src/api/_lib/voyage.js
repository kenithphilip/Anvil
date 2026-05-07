// Voyage AI embeddings client.
//
// Audit P8.4. Used by the catalog indexer + the semantic-search
// endpoint to embed item descriptions and customer queries. Voyage
// is the cost-effective sibling of OpenAI text-embedding-3-large
// for B2B catalog data; voyage-3 emits 1024-dim float vectors.
//
// We hit the public REST API directly via safeFetch (the same
// outbound wrapper the rest of the codebase uses). Per-call cost
// at voyage-3 is ~$0.00006 / 1k tokens; a typical part description
// is ~30 tokens so embedding the entire item_master for a tenant
// is sub-cent.

import { safeFetch } from "./safe-fetch.js";

const VOYAGE_URL = process.env.VOYAGE_API_URL || "https://api.voyageai.com/v1/embeddings";
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || "";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-3";

export const voyageIsConfigured = () => !!VOYAGE_KEY;

// Embed a list of texts. Returns { ok, vectors, model, error? }.
// Voyage caps batch size at 128 strings; the caller chunks if
// needed.
export const voyageEmbed = async (texts, opts) => {
  if (!VOYAGE_KEY) return { ok: false, error: "VOYAGE_API_KEY not set" };
  const inputs = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").slice(0, 8000))
    .filter((t) => t.length > 0);
  if (!inputs.length) return { ok: true, vectors: [], model: VOYAGE_MODEL };
  if (inputs.length > 128) {
    return { ok: false, error: "voyage batch limit is 128 inputs; chunk before calling" };
  }
  let resp;
  try {
    resp = await safeFetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + VOYAGE_KEY,
      },
      body: JSON.stringify({
        input: inputs,
        model: opts?.model || VOYAGE_MODEL,
        // input_type: 'document' for indexing, 'query' for query
        // expansion. Voyage's docs say it improves recall ~2-3%.
        input_type: opts?.input_type || "document",
      }),
    });
  } catch (err) {
    return { ok: false, error: "voyage fetch: " + err.message };
  }
  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    return { ok: false, status: resp.status, error: "voyage " + resp.status + ": " + body.slice(0, 300) };
  }
  let data;
  try { data = await resp.json(); }
  catch (err) { return { ok: false, error: "voyage response parse: " + err.message }; }
  const blocks = Array.isArray(data?.data) ? data.data : [];
  const vectors = blocks
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((b) => b.embedding);
  if (vectors.length !== inputs.length) {
    return { ok: false, error: "voyage returned " + vectors.length + " vectors for " + inputs.length + " inputs" };
  }
  return {
    ok: true,
    vectors,
    model: data?.model || opts?.model || VOYAGE_MODEL,
    usage: data?.usage,
  };
};

// Build the canonical text we feed Voyage for each item. Keeping
// this stable + minimal means re-embeds only fire when the inputs
// actually change.
export const itemEmbedText = (item) => {
  const parts = [];
  if (item.part_no) parts.push(item.part_no);
  if (item.description) parts.push(item.description);
  if (item.item_group) parts.push(item.item_group);
  if (item.sub_category) parts.push(item.sub_category);
  return parts.join(" :: ").slice(0, 2000);
};
