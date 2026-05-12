// Pre-extraction document profiler.
//
// One cheap Haiku-tier LLM call that classifies each page of a
// PDF without extracting line items. The profiler answers two
// questions:
//
//   1. Is this a PO, RFQ, amendment, or non-PO? Cheap fail-fast
//      for documents that arrived in the queue by mistake.
//
//   2. Which pages carry line items vs. T&C boilerplate /
//      signatures / inspection criteria / cover sheets? The
//      page-keep list feeds chunkedExtract.opts.keepPages so the
//      expensive extractor only reads the substantive pages.
//
// Cost shape. A 70-page PO at preflight tier (Haiku) costs
// ~$0.005 to profile, then ~5 of those 70 pages reach the
// extraction tier. The unprofiled equivalent would either cost
// 10x more or fail outright on the input-token budget.
//
// Fallback. When the profiler call fails (Anthropic outage, key
// missing, low confidence), the caller falls back to "extract
// every page" so a profiler failure can't block extraction. The
// budget cost is the only thing lost.

import { callAnthropic, cacheableSystem, cacheableTools } from "../anthropic.js";

const PROFILER_SYSTEM_PROMPT = [
  "You are a document triage classifier for a B2B sales-ops platform.",
  "",
  "You receive a customer purchase order (or RFQ / amendment / non-PO document) as a PDF.",
  "Your job is to label what each page is, not to extract any line-item data. Be conservative;",
  "if you are unsure about a page, mark it `line_items` so the downstream extractor still reads it.",
  "",
  "STEP 1: Classify the document overall:",
  "  - po          customer purchase order, ready to fulfil",
  "  - rfq         request for quotation",
  "  - amendment   change order against a prior PO",
  "  - non_po      spec sheet, drawing, marketing material, unrelated content",
  "",
  "STEP 2: Label every page with one of:",
  "  - line_items     a page that carries one or more order line items in a table or block layout",
  "  - header         contact / billing / shipping / payment header info, no line items",
  "  - terms          terms & conditions, boilerplate, legal text, warranty, dispute resolution",
  "  - signature      signature block, sign-off page, authorisation",
  "  - inspection     inspection criteria, quality checks, test protocols",
  "  - cover          cover sheet, table of contents, blank page",
  "  - drawing        engineering drawing, schematic, spec image",
  "  - other          something else; the downstream extractor will read it just in case",
  "",
  "STEP 3: Return the list of page numbers that carry line items, in order. This list drives",
  "page-keep selection for the expensive extractor downstream. A header page that ALSO has line",
  "items goes in the list; a header page with no line items does not.",
  "",
  "STEP 4: Self-assess confidence 0-1. 0.95 means every page is clearly classifiable from the",
  "printed structure; 0.7 means the document layout is ambiguous; below 0.6 the caller will",
  "fall back to extracting every page.",
  "",
  "Hard rules:",
  "  - Pages are 1-indexed.",
  "  - line_item_pages must be sorted ascending and contain no duplicates.",
  "  - When in doubt, prefer keeping a page (mark as line_items) over dropping it. The cost of",
  "    extracting one extra boilerplate page is small; the cost of missing a line is large.",
  "  - Never extract or summarise line-item values. This is a triage step, not an extractor.",
].join("\n");

const PROFILER_TOOL = {
  name: "classify_document_pages",
  description: "Return the document-level classification + a per-page label list + the indices of pages that carry line items.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      classification: {
        type: "string",
        enum: ["po", "rfq", "amendment", "non_po"],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      page_count: { type: "integer", minimum: 0 },
      page_categories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "integer", minimum: 1 },
            kind: {
              type: "string",
              enum: ["line_items", "header", "terms", "signature", "inspection", "cover", "drawing", "other"],
            },
          },
          required: ["page", "kind"],
        },
      },
      line_item_pages: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
      reason: { type: ["string", "null"], description: "One-line note when classification != 'po', or when confidence is low." },
    },
    required: ["classification", "confidence", "page_count", "page_categories", "line_item_pages"],
  },
};

// Build the user-content blocks for the profiler call. The
// Anthropic API accepts a PDF document block; we pass the
// caller's bytes through unchanged.
const buildProfilerMessage = (source) => {
  const blocks = [];
  blocks.push({ type: "text", text: "DOCUMENT TO TRIAGE" });
  if (source.bytes) {
    const base64 = Buffer.isBuffer(source.bytes)
      ? source.bytes.toString("base64")
      : (source.bytes instanceof Uint8Array
          ? Buffer.from(source.bytes).toString("base64")
          : String(source.bytes));
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    });
  } else if (source.url) {
    blocks.push({
      type: "document",
      source: { type: "url", url: source.url },
    });
  }
  return [{ role: "user", content: blocks }];
};

const extractToolUse = (data, toolName) => {
  if (!data || !Array.isArray(data.content)) return null;
  for (const block of data.content) {
    if (block && block.type === "tool_use" && block.name === toolName) return block.input || null;
  }
  return null;
};

// Sanitise the model's return: pages must be 1-indexed integers
// within [1, page_count], deduped + sorted. Out-of-range entries
// are dropped silently because the downstream chunker would drop
// them anyway.
const sanitiseLineItemPages = (raw, pageCount) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > pageCount) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
};

// Public entry point.
//
// Inputs:
//   source         { bytes | url, mime, filename }
//   tenantId       required for callAnthropic firewall + telemetry
//   minConfidence  threshold below which the caller should
//                  ignore the page-keep list (default 0.6)
//
// Returns:
//   { ok, classification, line_item_pages, page_categories,
//     page_count, confidence, reason, raw, attempts }
//
// When ok=false, line_item_pages will be empty and the caller
// should extract every page. raw carries the original Claude
// response for diagnostics.
export const profileDocument = async ({ source, tenantId, minConfidence = 0.6, svc = null }) => {
  if (!source || (!source.bytes && !source.url)) {
    return { ok: false, error: "no_source", line_item_pages: [], page_categories: [], classification: null, confidence: 0 };
  }

  const messages = buildProfilerMessage(source);
  // Phase F #24: cache the system prompt + tool schema. Both
  // are static across every profiler call, so the cache hits on
  // the 2nd-Nth call within the 5-minute TTL and the input-token
  // cost drops ~90%. The PDF block is per-call and stays
  // uncached.
  const resp = await callAnthropic({
    tenantId,
    purpose: "extraction",
    tier: "preflight",
    max_tokens: 4000,
    temperature: 0,
    system: cacheableSystem(PROFILER_SYSTEM_PROMPT),
    messages,
    tools: cacheableTools([PROFILER_TOOL]),
    tool_choice: { type: "tool", name: PROFILER_TOOL.name },
    svc,
  });
  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: resp?.error || "anthropic_failed",
      line_item_pages: [],
      page_categories: [],
      classification: null,
      confidence: 0,
      raw: resp?.data || null,
    };
  }
  const input = extractToolUse(resp.data, PROFILER_TOOL.name);
  if (!input) {
    return {
      ok: false,
      error: "no_tool_use",
      line_item_pages: [],
      page_categories: [],
      classification: null,
      confidence: 0,
      raw: resp.data,
    };
  }
  const pageCount = Math.max(0, Number(input.page_count) || 0);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
  const lineItemPages = sanitiseLineItemPages(input.line_item_pages, pageCount);
  const lowConfidence = confidence < minConfidence;
  // Reason precedence: "low_confidence" is the machine-readable
  // signal that drives fallback behaviour, so it wins when
  // confidence trips the threshold regardless of any free-text
  // model reason. The model's reason is kept on raw for
  // operator-visible diagnostics.
  const reason = lowConfidence ? "low_confidence" : (input.reason || null);
  return {
    ok: !lowConfidence && lineItemPages.length > 0,
    classification: input.classification || null,
    confidence,
    page_count: pageCount,
    page_categories: Array.isArray(input.page_categories) ? input.page_categories : [],
    line_item_pages: lineItemPages,
    reason,
    model_reason: input.reason || null,
    raw: resp.data,
    model: resp.model || null,
    latency_ms: resp.latency_ms || null,
  };
};

export const __test = { sanitiseLineItemPages, extractToolUse };
