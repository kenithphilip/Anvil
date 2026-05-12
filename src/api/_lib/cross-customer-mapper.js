// Cross-customer item-mapping (Wave 3.4 / #15).
//
// item-mapper.js resolves a PO line to an item_master row using
// a tiered chain: customer_part / item_master.part_no /
// specification_code / alias / description_fuzzy. Tier 1
// (customer_part) is scoped to (tenant_id, customer_id, part_no);
// a new customer with no rows in item_customer_parts gets no
// help from any prior customer's mapped lines.
//
// Some lines should be cross-customer-resolvable. If customer A
// has confirmed "BEND ADAPTER X1" -> canonical THB-001, and
// customer B sends a line description "BEND ADAPTER X1" with a
// different customer_part_number, the resolver should suggest
// the same canonical item. This is NOT a hard match (we can't
// auto-confirm because customer B's BOM might differ), but it
// IS a useful suggestion for the operator.
//
// This module:
//   1. Builds a description -> canonical_item_id index from
//      item_customer_parts JOIN item_master. Cached per tenant
//      for 30 minutes (the active learning loop tolerates this
//      staleness; a new mapping shows up on the next refresh).
//   2. Scores incoming line descriptions against the index via
//      word-overlap (same algorithm item-mapper.js's tier 5
//      already uses).
//   3. Returns suggestions with provenance: "this canonical
//      item was previously mapped by N other customers from a
//      similar description".
//
// Distinct from item-mapper-llm.js (Layer C): that one builds
// candidates per-line and asks Claude to pick. This one is
// deterministic, pre-LLM, and surfaces suggestions for ANY
// canonical item that has been mapped by ANY tenant customer.
// The Layer C LLM can then read these as hints.

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();           // key = tenant_id, value = { at, index }

const STOP_WORDS = new Set([
  "a","an","the","and","or","of","for","with","to","in","by",
  "no","nos","each","pcs","piece","pieces","set","unit","units",
]);

export const significantWords = (s) => {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
};

const cacheKey = (tenantId) => String(tenantId);

const fromCache = (tenantId) => {
  const c = cache.get(cacheKey(tenantId));
  if (!c) return null;
  if (Date.now() - c.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(tenantId));
    return null;
  }
  return c.index;
};

const toCache = (tenantId, index) => {
  cache.set(cacheKey(tenantId), { at: Date.now(), index });
};

export const __test = {
  clearCache: () => cache.clear(),
};

// Build the index: for every confirmed mapping in the tenant,
// produce a row { itemId, partNo, descriptionWords, customerId,
// customerCount }. customerCount is the number of DISTINCT
// customers that ever mapped this canonical item.
//
// The index is a flat list; scoring scans it linearly. Tenants
// with <50k mappings are fine.
export const buildCrossCustomerIndex = async (svc, tenantId, opts = {}) => {
  if (!svc || !tenantId) return [];
  if (!opts.skipCache) {
    const cached = fromCache(tenantId);
    if (cached) return cached;
  }
  let mappings = [];
  try {
    const r = await svc.from("item_customer_parts")
      .select("item_id, customer_id, customer_part_number, customer_part_description, confirmed_at")
      .eq("tenant_id", tenantId);
    mappings = r?.data || [];
  } catch (_e) { mappings = []; }
  if (!mappings.length) {
    toCache(tenantId, []);
    return [];
  }
  const itemIds = Array.from(new Set(mappings.map((m) => m.item_id).filter(Boolean)));
  if (!itemIds.length) {
    toCache(tenantId, []);
    return [];
  }
  let masters = [];
  try {
    const r = await svc.from("item_master")
      .select("id, part_no, description, print_name, alias")
      .eq("tenant_id", tenantId)
      .in("id", itemIds);
    masters = r?.data || [];
  } catch (_e) { masters = []; }
  const masterById = new Map(masters.map((m) => [m.id, m]));
  // Group mappings by item_id, count distinct customers.
  const byItem = new Map();
  for (const m of mappings) {
    if (!m.item_id) continue;
    if (!byItem.has(m.item_id)) byItem.set(m.item_id, { customers: new Set(), descriptions: new Set() });
    byItem.get(m.item_id).customers.add(m.customer_id);
    if (m.customer_part_description) byItem.get(m.item_id).descriptions.add(m.customer_part_description);
  }
  const index = [];
  for (const [itemId, grp] of byItem) {
    const master = masterById.get(itemId);
    if (!master) continue;
    const corpus = [
      master.part_no, master.description, master.print_name, master.alias,
      ...Array.from(grp.descriptions),
    ].filter(Boolean).join(" ");
    index.push({
      itemId,
      partNo: master.part_no,
      description: master.description,
      print_name: master.print_name,
      words: new Set(significantWords(corpus)),
      customerCount: grp.customers.size,
    });
  }
  toCache(tenantId, index);
  return index;
};

// Score a query line against the index. Returns top-N suggestions
// sorted by score desc. Score is word-overlap-count weighted by
// log(customerCount + 1) so an item mapped by 4 customers ranks
// above an item mapped by only 1.
//
// Returns: [{ item_id, part_no, description, customer_count,
//             score, overlap_words }]
export const suggestCrossCustomer = (index, line, opts = {}) => {
  const limit = Number(opts.limit || 3);
  if (!index?.length || !line) return [];
  const qWords = new Set(
    significantWords([line.description, line.partNumber, line.itemCode, line.customer_part_description].filter(Boolean).join(" ")),
  );
  if (qWords.size === 0) return [];
  const scored = [];
  for (const row of index) {
    let overlap = 0;
    for (const w of qWords) if (row.words.has(w)) overlap++;
    if (overlap === 0) continue;
    const customerBoost = Math.log(row.customerCount + 1);
    const score = overlap * (1 + customerBoost);
    scored.push({
      item_id: row.itemId,
      part_no: row.partNo,
      description: row.description,
      print_name: row.print_name,
      customer_count: row.customerCount,
      score,
      overlap_words: overlap,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
};

// One-shot helper: build index + score a batch of lines. Returns
// per-line suggestions.
export const suggestForLines = async (svc, tenantId, lines, opts = {}) => {
  if (!Array.isArray(lines) || !lines.length) return [];
  const index = await buildCrossCustomerIndex(svc, tenantId, opts);
  if (!index.length) return lines.map(() => []);
  return lines.map((line) => suggestCrossCustomer(index, line, opts));
};
