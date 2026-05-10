// L3 customer-format templates.
//
// Phase D of EXTRACTION_PIPELINE_PLAN.md. After 3+ successful
// extractions for the same customer, we stamp a deterministic
// template that maps the document's anchor patterns directly to
// fields. The next time that customer's PO arrives, the template
// runs first; if it pulls every field, the LLM doesn't need to
// run at all.
//
// Two halves:
//
//   1. buildTemplate(svc, { tenantId, customerId, kind }):
//        Looks at the most-recent N successful runs for the
//        customer, derives anchor regexes from the body_text +
//        normalized_extract pairs, deduplicates against existing
//        templates, persists a new row into
//        customer_format_templates.
//
//   2. applyTemplate(svc, { tenantId, customerId, kind, bodyText }):
//        Runs the template's anchors against the document body
//        and returns a partially-filled normalized extraction
//        plus per-field confidence. Confidence is 0.95 because
//        the patterns came from operator-confirmed extractions.
//
// The dispatcher inserts L3 BEFORE L4 (LLM): if the template
// covers every field the operator needs, the LLM is skipped
// entirely. Otherwise the dispatcher merges template-extracted
// fields into the LLM prompt as `hints.knownFields` so the LLM
// only fills the gaps.

const RECENT_RUNS_LIMIT = 6;
const MIN_RUNS_TO_TEMPLATE = 3;
const TEMPLATE_FIELDS = [
  "customer.po_number", "customer.po_date", "customer.payment_terms",
  "customer.gstin", "customer.state_code", "customer.currency",
];
// Per-line repeating anchors are deferred to a follow-up; the
// header anchors above already cover the high-value fields. Lines
// continue to come through L4 (or L6 voter when configured).

const get = (obj, path) => {
  if (!obj) return null;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur == null ? null : cur;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build a regex anchor from a body-text snippet that ends with the
// known field value. We look at the 60 chars preceding the value
// and keep up to 30 chars of stable lead-in, then capture the
// value. The lead-in tolerates whitespace differences.
const inferAnchor = (bodyText, value) => {
  if (!bodyText || !value) return null;
  const v = String(value).trim();
  if (!v) return null;
  const idx = bodyText.indexOf(v);
  if (idx < 0) return null;
  const leadStart = Math.max(0, idx - 60);
  const lead = bodyText.slice(leadStart, idx);
  // Trim to a reasonable token: keep the last word/colon/dash that
  // looks like a label. We deliberately don't try to be clever
  // here; the regex tolerates extra whitespace.
  const labelMatch = lead.match(/([A-Za-z][\w\s./-]{1,40})[:\s]+$/);
  if (!labelMatch) return null;
  const label = labelMatch[1].trim();
  if (label.length < 3) return null;
  // Build the regex: <escaped label><whitespace>(<capture>)
  // The capture is greedy up to a newline or 80 chars.
  const labelRe = escapeRegex(label).replace(/\s+/g, "\\s+");
  return {
    pattern: `${labelRe}\\s*[:\\-]?\\s*(.{1,80}?)(?:\\r?\\n|$)`,
    capture_group: 1,
    label,
  };
};

// Run a regex against a body of text and return the captured group
// or null. Wrapper exists so the caller doesn't have to manage
// flag construction or invalid-regex throws.
const matchAnchor = (pattern, captureGroup, bodyText) => {
  let re;
  try { re = new RegExp(pattern, "im"); }
  catch (_) { return null; }
  const m = bodyText.match(re);
  if (!m) return null;
  const v = m[captureGroup];
  return v == null ? null : String(v).trim();
};

// Score an anchor against ALL of the runs we considered. Anchors
// that pull the same value as the original normalized extract for
// >= 2 of the runs are kept; the rest are discarded.
const scoreAnchor = (anchor, runs, fieldPath) => {
  if (!anchor) return 0;
  let hits = 0;
  for (const r of runs) {
    const text = r.body_text || "";
    const expected = String(get(r.normalized_extract, fieldPath) || "").trim();
    if (!expected || !text) continue;
    const captured = matchAnchor(anchor.pattern, anchor.capture_group, text);
    if (captured === expected) hits++;
  }
  return hits;
};

// Public: build (or refresh) a template for a (tenant, customer,
// kind). Reads recent successful runs that include both
// normalized_extract and an associated text_layer body_text via
// extraction_text_layer + ocr_layer. Idempotent: same input set
// produces the same anchors.
export const buildTemplate = async (svc, { tenantId, customerId, kind }) => {
  if (!tenantId || !customerId) return { ok: false, error: "tenantId + customerId required" };
  const k = kind || "po";
  // Pull recent ok runs for this customer + kind.
  const runsResp = await svc.from("extraction_runs")
    .select("id, source_id, normalized_extract")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "ok")
    .eq("extraction_kind", k)
    .order("started_at", { ascending: false })
    .limit(RECENT_RUNS_LIMIT);
  if (runsResp.error) return { ok: false, error: runsResp.error.message };
  const runs = runsResp.data || [];
  if (runs.length < MIN_RUNS_TO_TEMPLATE) {
    return { ok: false, reason: "not_enough_runs", runs_considered: runs.length };
  }

  // Pull body_text for those runs by joining via documents->text_layer.
  // The runs carry source_id which is the documents.id when the run
  // came from the upload path.
  const docIds = runs.map((r) => r.source_id).filter(Boolean);
  const bodyTexts = new Map();
  if (docIds.length) {
    const tlResp = await svc.from("extraction_text_layer")
      .select("document_id, body_text")
      .eq("tenant_id", tenantId)
      .in("document_id", docIds);
    for (const row of (tlResp.data || [])) {
      if (row.body_text) bodyTexts.set(row.document_id, row.body_text);
    }
    // Fall back to OCR layer when L1 had no text.
    const tlMissing = docIds.filter((d) => !bodyTexts.has(d));
    if (tlMissing.length) {
      const ocrResp = await svc.from("extraction_ocr_layer")
        .select("document_id, body_text")
        .eq("tenant_id", tenantId)
        .in("document_id", tlMissing);
      for (const row of (ocrResp.data || [])) {
        if (row.body_text) bodyTexts.set(row.document_id, row.body_text);
      }
    }
  }

  const enriched = runs
    .map((r) => ({ ...r, body_text: bodyTexts.get(r.source_id) || null }))
    .filter((r) => r.body_text && r.normalized_extract);

  if (enriched.length < MIN_RUNS_TO_TEMPLATE) {
    return { ok: false, reason: "not_enough_text", runs_considered: enriched.length };
  }

  const anchors = [];
  for (const fp of TEMPLATE_FIELDS) {
    // Use the most recent run as the seed.
    const seed = enriched[0];
    const seedValue = get(seed.normalized_extract, fp);
    if (!seedValue) continue;
    const anchor = inferAnchor(seed.body_text, seedValue);
    if (!anchor) continue;
    const hits = scoreAnchor(anchor, enriched, fp);
    if (hits >= 2) {
      anchors.push({ field: fp, ...anchor, sample_value: String(seedValue).slice(0, 120), hits });
    }
  }

  if (!anchors.length) {
    return { ok: false, reason: "no_anchors_inferable", runs_considered: enriched.length };
  }

  const sourceRunIds = enriched.map((r) => r.id);
  const sampleHashes = enriched.map((r) => r.source_id).filter(Boolean);

  // Upsert: one active template per (tenant, customer, kind). Older
  // templates archive when this one supersedes them.
  await svc.from("customer_format_templates")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("kind", k)
    .eq("status", "active");

  const ins = await svc.from("customer_format_templates").insert({
    tenant_id: tenantId,
    customer_id: customerId,
    kind: k,
    anchors,
    line_anchors: [],
    sample_doc_hashes: sampleHashes,
    source_run_ids: sourceRunIds,
    hit_count: 0,
    miss_count: 0,
    status: "active",
  }).select("*").single();
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true, template: ins.data, anchors_inferred: anchors.length };
};

// Apply the active template for a (tenant, customer, kind) to a
// body of text. Returns:
//   {
//     used: boolean,
//     template_id: uuid | null,
//     normalized: { customer: {...partial} },
//     confidences: { "customer.<field>": 0.95, ... },
//     hits: number,
//     misses: number,
//   }
export const applyTemplate = async (svc, { tenantId, customerId, kind, bodyText }) => {
  if (!tenantId || !customerId || !bodyText) return { used: false };
  const k = kind || "po";
  const tplResp = await svc.from("customer_format_templates")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("kind", k)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tplResp.error || !tplResp.data) return { used: false };
  const tpl = tplResp.data;
  const anchors = Array.isArray(tpl.anchors) ? tpl.anchors : [];
  if (!anchors.length) return { used: false };

  const out = { customer: {} };
  const confidences = {};
  let hits = 0;
  let misses = 0;
  for (const a of anchors) {
    const captured = matchAnchor(a.pattern, a.capture_group, bodyText);
    if (captured) {
      const fp = a.field;
      const subPath = fp.replace(/^customer\./, "");
      out.customer[subPath] = captured;
      confidences[fp] = 0.95;
      hits++;
    } else {
      misses++;
    }
  }

  // Update hit / miss accounting.
  const updates = {};
  if (hits > 0) {
    updates.hit_count = (tpl.hit_count || 0) + 1;
    updates.last_hit_at = new Date().toISOString();
  }
  if (misses > 0 && hits === 0) {
    updates.miss_count = (tpl.miss_count || 0) + 1;
    updates.last_miss_at = new Date().toISOString();
  }
  if (Object.keys(updates).length) {
    await svc.from("customer_format_templates").update(updates).eq("id", tpl.id);
  }

  // Auto-archive: if miss_count exceeds hit_count by >= 3, archive
  // the template so the LLM path takes over again.
  if ((tpl.miss_count + (updates.miss_count || 0)) >= (tpl.hit_count + (updates.hit_count || 0)) + 3) {
    await svc.from("customer_format_templates").update({
      status: "archived",
      archived_at: new Date().toISOString(),
    }).eq("id", tpl.id);
  }

  return {
    used: hits > 0,
    template_id: tpl.id,
    normalized: out,
    confidences,
    hits,
    misses,
  };
};

// Exported for tests.
export const __test__ = { inferAnchor, scoreAnchor, escapeRegex, matchAnchor };
