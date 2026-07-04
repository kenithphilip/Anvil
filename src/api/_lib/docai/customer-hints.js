// Customer-hint priming for extractor prompts (Wave 1.5 / #13).
//
// When the dispatcher knows the customerId, it has a wealth of
// prior context that can prime the extractor's prompt: the
// customer's display name + GSTIN, the operator-confirmed field
// overrides, the line-pattern distribution from recent successful
// extractions (most common HSN codes, GST percentages, currencies,
// and typical PO formats), and a small sample of known
// customer_part -> canonical-item mappings so the LLM can
// recognise the customer's part-numbering convention.
//
// Why this matters:
//   1. The model needs fewer guesses on customer-block fields
//      (name, GSTIN, address) when we tell it what to expect.
//   2. Line-item HSN/GST predictions converge faster when the
//      model sees three recent examples from the same customer.
//   3. The customer part-number convention (Meridian writes
//      CH-DZ-010505 for every entry, Acme writes ACM-LL-000123)
//      is learnable from 5 examples; the extractor sees it as a
//      pattern instead of a string.
//
// This module produces a structured hint object that the adapters
// embed in their system prompt. The block goes after the operator-
// confirmed knownFields block (Phase D) and before the document
// body. Prompt caching (Wave 1.1) keeps the hint cached at 0.1x
// reads for the 5-minute TTL window.
//
// Cheap. One Postgres query per source table (customers,
// customer_field_overrides, extraction_runs, item_customer_parts).
// Cached per (tenant_id, customer_id) for 15 minutes so repeated
// extractions on the same customer don't re-query.

import { topKWeighted } from "../decay-weight.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const LINE_HISTORY_LIMIT = 8;          // recent line-bearing runs to scan
const TOP_HSN_COUNT = 5;
const TOP_GST_COUNT = 3;
const ITEM_MAPPING_SAMPLE = 5;
const RECENT_CORRECTIONS_LIMIT = 50;
const TOP_K_CORRECTIONS = 8;

const cache = new Map();               // key = tenantId + "|" + customerId

const cacheKey = (tenantId, customerId) => tenantId + "|" + customerId;

const fromCache = (tenantId, customerId) => {
  const k = cacheKey(tenantId, customerId);
  const v = cache.get(k);
  if (!v) return { hit: false, value: null };
  if (Date.now() - v.at > CACHE_TTL_MS) {
    cache.delete(k);
    return { hit: false, value: null };
  }
  return { hit: true, value: v.value };
};

const toCache = (tenantId, customerId, value) => {
  cache.set(cacheKey(tenantId, customerId), { at: Date.now(), value });
};

export const __test = {
  clearCache: () => cache.clear(),
  inspectCache: () => Array.from(cache.entries()),
};

// Count items in an iterable and return the top-N as [{value, count}].
const topN = (xs, n) => {
  const counts = new Map();
  for (const x of xs) {
    if (x == null || x === "") continue;
    const k = String(x);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
};

// Aggregate line-level signals from a set of recent normalized
// extraction outputs. We pull HSN, GST percentage, UOM, currency,
// and infer a part-number prefix from the customer-part-numbers
// the lines carried.
export const summariseLinePatterns = (runs) => {
  const hsn = [];
  const gst = [];
  const uom = [];
  const currency = [];
  const partPrefixes = [];
  let totalLines = 0;
  for (const r of runs) {
    const norm = r?.normalized_extract;
    if (!norm) continue;
    if (norm.customer?.currency) currency.push(norm.customer.currency);
    const lines = Array.isArray(norm.lines) ? norm.lines : [];
    totalLines += lines.length;
    for (const line of lines) {
      if (line.hsn) hsn.push(line.hsn);
      if (Number.isFinite(Number(line.gst_pct))) gst.push(Number(line.gst_pct));
      if (line.uom) uom.push(line.uom);
      if (line.partNumber && typeof line.partNumber === "string") {
        // Take the first 3-character "prefix" before the first
        // digit or dash, which is the customer's stable scheme.
        const m = line.partNumber.match(/^([A-Za-z]{2,5})/);
        if (m) partPrefixes.push(m[1].toUpperCase());
      }
    }
  }
  return {
    line_count_sample: totalLines,
    top_hsn:        topN(hsn,        TOP_HSN_COUNT),
    top_gst_pct:    topN(gst,        TOP_GST_COUNT),
    top_uom:        topN(uom,        TOP_GST_COUNT),
    top_currency:   topN(currency,   2),
    common_part_prefixes: topN(partPrefixes, 3),
  };
};

// Build the prompt-ready hint string. Returns null when there's no
// useful signal (new customer, no recent runs, etc.) so the caller
// can skip embedding the block.
export const renderHintBlock = (hint) => {
  if (!hint) return null;
  const parts = [];
  if (hint.identity?.display_name) {
    parts.push("Customer: " + hint.identity.display_name);
  }
  if (hint.identity?.gstin) parts.push("Expected GSTIN: " + hint.identity.gstin);
  if (hint.identity?.country) parts.push("Country: " + hint.identity.country);
  if (hint.line_patterns?.top_currency?.[0]?.value) {
    parts.push("Default currency: " + hint.line_patterns.top_currency[0].value);
  }
  if (hint.line_patterns?.top_hsn?.length) {
    parts.push("Recent HSN codes: " + hint.line_patterns.top_hsn.map((x) => x.value).join(", "));
  }
  if (hint.line_patterns?.top_gst_pct?.length) {
    parts.push("Typical GST %: " + hint.line_patterns.top_gst_pct.map((x) => x.value).join(", "));
  }
  if (hint.line_patterns?.common_part_prefixes?.length) {
    parts.push("Customer part-number prefixes: " + hint.line_patterns.common_part_prefixes.map((x) => x.value).join(", "));
  }
  if (hint.item_mappings_sample?.length) {
    const sample = hint.item_mappings_sample.slice(0, ITEM_MAPPING_SAMPLE)
      .map((m) => "  " + m.customer_part_number + " -> " + m.canonical_part_no);
    parts.push("Sample customer-part to canonical mappings:\n" + sample.join("\n"));
  }
  // Wave CM 3.2: recent operator corrections, sorted by decay
  // weight (newer = higher weight). Each line is short so the
  // model can pattern-match without bleeding attention.
  if (hint.recent_corrections?.length) {
    const lines = hint.recent_corrections.slice(0, 6).map((c) => {
      const op = typeof c.operator_value === "object" ? JSON.stringify(c.operator_value) : String(c.operator_value ?? "");
      const mv = typeof c.model_value === "object" ? JSON.stringify(c.model_value) : String(c.model_value ?? "");
      const w = typeof c.weight === "number" ? c.weight.toFixed(2) : "?";
      return "  " + c.field_path + ": model='" + mv.slice(0, 40) + "' -> operator='" + op.slice(0, 40) + "' (w=" + w + ")";
    });
    parts.push("Recent operator corrections (weight is the recency decay; 1.0 is today):\n" + lines.join("\n"));
  }
  if (!parts.length) return null;
  return parts.join("\n");
};

// Public entry. Returns the structured hint (suitable for inclusion
// in normalized output for the audit trail) and the rendered text
// block (for embedding in the system prompt).
//
// Returns null when there is no useful signal.
//
// CM 3.3: opts.contactId attributes priming to one buyer at a
// multi-buyer customer. When supplied, corrections by THIS
// contact get a 1.5x weight boost relative to corrections from
// other contacts at the same customer; the model then sees the
// buyer-specific pattern at the top of the prompt.
const CONTACT_MATCH_WEIGHT_BOOST = 1.5;
export const buildCustomerHints = async (svc, { tenantId, customerId, opts = {} }) => {
  if (!svc || !tenantId || !customerId) return null;
  const contactId = opts?.contactId || null;
  // Cache by (tenant, customer, contact?) so two different
  // buyers at the same customer get distinct hint priming.
  const cacheKeyContact = contactId ? customerId + "|" + contactId : customerId;
  if (!opts.skipCache) {
    const cached = fromCache(tenantId, cacheKeyContact);
    if (cached.hit) return cached.value;
  }

  // 1. Customer identity. Tolerate either `customers` or
  //    `customer_master` depending on the migration vintage.
  let identity = null;
  try {
    const r = await svc.from("customers")
      .select("id, display_name, gstin, country, currency_default")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle();
    if (r?.data) {
      identity = {
        display_name: r.data.display_name,
        gstin: r.data.gstin,
        country: r.data.country,
        default_currency: r.data.currency_default,
      };
    }
  } catch (_e) { identity = null; }

  // 2. Operator-confirmed overrides. We don't render every field;
  //    only the customer-level fields (name, gstin, billing_address)
  //    that the model would otherwise re-extract.
  let confirmedFields = [];
  try {
    const r = await svc.from("customer_field_overrides")
      .select("field_path, replacement")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .limit(40);
    confirmedFields = (r?.data || []).filter((x) => x.replacement && typeof x.replacement === "string");
  } catch (_e) { confirmedFields = []; }

  // 3. Line patterns from recent successful runs.
  let linePatterns = null;
  try {
    const r = await svc.from("extraction_runs")
      .select("normalized_extract, started_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(LINE_HISTORY_LIMIT);
    linePatterns = summariseLinePatterns(r?.data || []);
  } catch (_e) { linePatterns = null; }

  // 3b. Wave CM 3.2 + 3.3: recent operator corrections, decay-
  //     weighted and (optionally) contact-attributed. When the
  //     caller passes contactId, corrections by that contact get
  //     a 1.5x weight boost before top-K so the per-buyer pattern
  //     dominates the prompt. Without contactId, plain decay.
  let recentCorrections = [];
  try {
    const r = await svc.from("learned_corrections")
      .select("field_path, model_value, operator_value, severity, created_at, diff_kind, customer_contact_id")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(RECENT_CORRECTIONS_LIMIT);
    let rows = r?.data || [];
    // CM 3.3 boost: multiply weight by 1.5 for rows attributed
    // to the current contact. The decay-weight module emits
    // weight after the topKWeighted call below; we pre-stamp a
    // _contact_boost so the comparator can lift them.
    if (contactId) {
      rows = rows.map((row) => ({
        ...row,
        _contact_boost: row.customer_contact_id === contactId ? CONTACT_MATCH_WEIGHT_BOOST : 1,
      }));
    }
    const ranked = topKWeighted(rows, TOP_K_CORRECTIONS).map((row) => ({
      ...row,
      weight: row.weight * (row._contact_boost || 1),
    }));
    // Re-sort after the boost is applied.
    ranked.sort((a, b) => b.weight - a.weight);
    recentCorrections = ranked.filter((row) => row.weight > 0.05);
  } catch (_e) { recentCorrections = []; }

  // 4. A small sample of item_customer_parts so the model sees the
  //    customer's part-numbering scheme.
  let itemMappingsSample = [];
  try {
    const r = await svc.from("item_customer_parts")
      .select("customer_part_number, item_id")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("confirmed_at", { ascending: false, nullsFirst: false })
      .limit(ITEM_MAPPING_SAMPLE * 2);
    const partRows = r?.data || [];
    if (partRows.length) {
      const itemIds = Array.from(new Set(partRows.map((x) => x.item_id).filter(Boolean)));
      const im = await svc.from("item_master")
        .select("id, part_no")
        .eq("tenant_id", tenantId)
        .in("id", itemIds);
      const byId = new Map((im?.data || []).map((x) => [x.id, x.part_no]));
      itemMappingsSample = partRows
        .filter((x) => byId.has(x.item_id))
        .slice(0, ITEM_MAPPING_SAMPLE)
        .map((x) => ({
          customer_part_number: x.customer_part_number,
          canonical_part_no: byId.get(x.item_id),
        }));
    }
  } catch (_e) { itemMappingsSample = []; }

  const empty = (
    !identity
    && !confirmedFields.length
    && !(linePatterns?.line_count_sample)
    && !itemMappingsSample.length
    && !recentCorrections.length
  );
  if (empty) {
    toCache(tenantId, cacheKeyContact, null);
    return null;
  }

  const hint = {
    identity,
    confirmed_fields: confirmedFields.map((x) => x.field_path),
    line_patterns: linePatterns,
    item_mappings_sample: itemMappingsSample,
    recent_corrections: recentCorrections,
    contact_id: contactId,
  };
  hint.rendered = renderHintBlock(hint);
  toCache(tenantId, cacheKeyContact, hint);
  return hint;
};
