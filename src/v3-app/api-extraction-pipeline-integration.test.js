// End-to-end integration tests for the unified extraction pipeline.
//
// These tests don't run against a live Supabase / Anthropic; we
// stub the I/O layer with an in-memory shim that mimics the
// shapes the real services return. The goal is to prove that
// the layers actually compose: a single runExtractionPipeline()
// call drives B + C + D + E + F.6 in the right order with the
// right data flowing between them.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async ({ bytes }) => {
    if (!bytes || bytes.length < 8) {
      return { ok: false, status: "extract_failed", page_count: 0, char_count: 0,
               body_text: null, page_breakdown: [], extractor: "unpdf",
               extractor_version: "test", latency_ms: 1, error: "no bytes" };
    }
    // Simulate an image-only PDF when the body says "image-only".
    const s = bytes.toString("utf8");
    if (s.includes("image-only")) {
      return { ok: false, status: "image_only", page_count: 2, char_count: 12,
               body_text: null, page_breakdown: [], extractor: "unpdf",
               extractor_version: "test", latency_ms: 3, error: null };
    }
    // Otherwise pretend we extracted text.
    return { ok: true, status: "has_text", page_count: 1, char_count: 500,
             body_text: s.slice(0, 500), page_breakdown: [{ page: 1, chars: 500, has_text: true }],
             extractor: "unpdf", extractor_version: "test", latency_ms: 5, error: null };
  }),
  contentHash: vi.fn(async () => "sha-stub"),
  looksLikePdf: () => true,
  TEXT_LAYER_THRESHOLDS: { usable: 200, perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async ({ buffer }) => {
    if (!buffer) return { ok: false, status: "failed", page_count: 0, char_count: 0,
                          body_text: null, page_breakdown: [], bbox_count: 0,
                          provider: "mistral", provider_model: null, latency_ms: 1,
                          raw_pages: [], error: "no bytes" };
    // Pretend OCR found text.
    return { ok: true, status: "ok", page_count: 2, char_count: 800,
             body_text: "OCR\nPO Number: PO-OCR-1\nGSTIN: 27AAACA1234B1Z5\n",
             page_breakdown: [{ page: 1, blocks: 4, chars: 400, has_text: true }],
             bbox_count: 12, provider: "mistral", provider_model: "mistral-ocr-latest",
             latency_ms: 200, raw_pages: [], error: null };
  }),
  OCR_LAYER_THRESHOLDS: { perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async ({ hints, settings }) => {
    // Single-adapter flag set when the voter runs each adapter
    // separately; we use the order list to pick which "adapter"
    // we're pretending to be.
    const order = settings?.docai_provider_order || [];
    const adapter = order[0] || "claude";
    return {
      ok: true,
      adapter_used: adapter,
      confidence_overall: adapter === "claude" ? 0.95 : 0.85,
      confidences: { overall: adapter === "claude" ? 0.95 : 0.85 },
      normalized: {
        classification: "po",
        customer: {
          name: "Acme",
          gstin: "27AAACA1234B1Z5",
          currency: "INR",
          po_number: hints?.knownFields?.po_number || "PO-DISPATCHED-1",
          payment_terms: "Net 30",
        },
        lines: [
          { partNumber: "BRG-6204", description: "Bearing", quantity: 100, unitPrice: 125, hsn: "8482", gst_pct: 18 },
        ],
      },
      raw: { adapter, body_text_in_hints: !!hints?.bodyText },
      attempts: [{ adapter, status: "ok" }],
      mode: hints?.bodyText ? "pre_extracted_text" : "pdf_document",
    };
  }),
  buildPromptOverrides: () => null,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

import { runExtractionPipeline } from "../api/_lib/docai/run.js";

// Build an in-memory svc that records every read + write so
// we can assert what the pipeline persisted.
const buildSvc = () => {
  const tables = new Map();
  const get = (t) => tables.get(t) || [];
  let runCounter = 1;

  const newCtx = (table) => ({ table, filters: [], action: null, values: null });

  const builder = (table) => {
    const ctx = newCtx(table);
    const api = {
      select(_c) { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      in(c, v) { ctx.filters.push({ col: c, op: "in", v }); return api; },
      is(c, v) { ctx.filters.push({ col: c, op: "is", v }); return api; },
      order(c) { ctx.order = c; return api; },
      limit(n) { ctx.limit = n; return api; },
      maybeSingle() { return Promise.resolve({ data: get(table)[0] || null, error: null }); },
      single() {
        const rows = get(table);
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "no row" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve) {
        // Make this thenable execute pending update / delete
        // operations against the matching rows. Without this, awaits
        // on `update(...).eq(...)` no-op and the inserted row keeps
        // its original column set.
        const matchesFilters = (r) => ctx.filters.every(
          (f) => (f.op === "eq" ? r[f.col] === f.v
            : f.op === "in" ? Array.isArray(f.v) && f.v.includes(r[f.col])
            : f.op === "is" ? r[f.col] === f.v
            : true)
        );
        if (ctx.action === "update") {
          const rows = get(table);
          const updated = rows.map((r) => (matchesFilters(r) ? { ...r, ...ctx.values } : r));
          tables.set(table, updated);
          resolve({ data: updated.filter(matchesFilters), error: null });
        } else if (ctx.action === "delete") {
          const rows = get(table);
          tables.set(table, rows.filter((r) => !matchesFilters(r)));
          resolve({ data: null, error: null });
        } else {
          resolve({ data: get(table).filter(matchesFilters), error: null });
        }
        return { catch: () => ({}) };
      },
      delete() { ctx.action = "delete"; return api; },
      update(values) { ctx.action = "update"; ctx.values = values; return api; },
      insert(values) {
        ctx.action = "insert"; ctx.values = values;
        const id = table === "extraction_runs" ? "run-" + (runCounter++) : "id-" + Math.random().toString(36).slice(2);
        const row = Array.isArray(values)
          ? values.map((v) => ({ id: "id-" + Math.random().toString(36).slice(2), ...v }))
          : { id, ...values };
        const existing = get(table);
        if (Array.isArray(row)) existing.push(...row); else existing.push(row);
        tables.set(table, existing);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: Array.isArray(row) ? row[0] : row, error: null }),
          }),
          then: (resolve) => { resolve({ data: Array.isArray(row) ? row : [row], error: null }); return { catch: () => ({}) }; },
        };
      },
      upsert(values, _opts) {
        ctx.action = "upsert"; ctx.values = values;
        const existing = get(table);
        existing.push({ id: "id-" + Math.random().toString(36).slice(2), ...values });
        tables.set(table, existing);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

beforeEach(() => { vi.clearAllMocks(); });

describe("integration / Phase B: image-only PDF triggers OCR fallback", () => {
  it("runs L1 -> image_only -> L2 OCR -> dispatcher with hints.bodyText", async () => {
    const svc = buildSvc();
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc, settings: {},
      bytes: Buffer.from("image-only PDF bytes here ".repeat(20)),
      filename: "scan.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: null, kind: "po",
    });
    expect(result.status).toBe("ok");
    expect(result.textLayerUsed).toBe(false);          // L1 returned image_only
    expect(result.ocrLayerUsed).toBe(true);            // L2 fired

    // Confirm the dispatcher received hints.bodyText (the OCR text).
    const { dispatchExtract } = await import("../api/_lib/docai/index.js");
    const lastCall = dispatchExtract.mock.calls.at(-1)[0];
    expect(lastCall.hints.bodyText).toMatch(/OCR/);
    expect(lastCall.source.bytes).toBeTruthy();
  });
});

describe("integration / Phase C: voter mode runs adapters in parallel", () => {
  it("runs every configured adapter in parallel and reduces by majority + confidence", async () => {
    const svc = buildSvc();
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc,
      settings: { docai_provider_order: ["claude", "reducto"] },
      bytes: Buffer.from("PDF text PO Number: PO-VOTE-1 ".repeat(30)),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: null, kind: "po",
      vote: true,
    });
    expect(result.voterUsed).toBe(true);
    expect(result.adapterUsed).toBe("voter");
    expect(result.fieldProvenance).toBeTruthy();
    expect(result.fieldProvenance.length).toBeGreaterThan(0);
    // Field provenance must include customer.gstin since both adapters returned it.
    const gstin = result.fieldProvenance.find((p) => p.field === "customer.gstin");
    expect(gstin?.value).toBe("27AAACA1234B1Z5");
    expect(gstin.voters.length).toBe(2);
  });
});

describe("integration / Phase E: customer overrides apply pre-validators", () => {
  it("applies customer_field_overrides to the dispatcher result before validators run", async () => {
    const svc = buildSvc();
    // Seed an override for this customer. Must include tenant_id +
    // customer_id so run.js's loadOverrides() (which filters by both)
    // returns it.
    svc._tables.set("customer_field_overrides", [
      {
        id: "ov-1",
        tenant_id: "t1",
        customer_id: "c1",
        field_path: "customer.payment_terms",
        match_pattern: null,                     // always-on
        replacement: "Net 60",
        confidence_floor: 0.95,
      },
    ]);
    // Stub the loadOverrides path: customer_field_overrides table is
    // already seeded, the run.js loader queries it by tenant +
    // customer.

    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc, settings: {},
      bytes: Buffer.from("PDF text Net 30 PO ".repeat(20)),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: "c1", kind: "po",
    });

    // The override should have flipped Net 30 -> Net 60.
    expect(result.normalized.customer.payment_terms).toBe("Net 60");
    expect(result.overridesApplied).toHaveLength(1);
    expect(result.overridesApplied[0].field_path).toBe("customer.payment_terms");
    expect(result.overridesApplied[0].before).toBe("Net 30");
    expect(result.overridesApplied[0].after).toBe("Net 60");
  });
});

describe("integration / status_reason: non_ack surfaces correctly", () => {
  it("maps a supplier_ack run with classification=non_ack to status='failed' status_reason='non_ack'", async () => {
    // Override the dispatcher to return a non_ack classification.
    const dispatcher = await import("../api/_lib/docai/index.js");
    dispatcher.dispatchExtract.mockResolvedValueOnce({
      ok: true,
      adapter_used: "claude",
      confidence_overall: 0.4,
      confidences: { overall: 0.4 },
      normalized: { classification: "non_ack", customer: null, lines: [] },
      raw: {},
      attempts: [{ adapter: "claude", status: "ok" }],
      mode: "pre_extracted_text",
    });
    const svc = buildSvc();
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc, settings: {},
      bytes: Buffer.from("PDF text supplier brochure ".repeat(20)),
      filename: "ack.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: null, kind: "supplier_ack",
    });
    expect(result.status).toBe("failed");
    expect(result.statusReason).toBe("non_ack");
  });
});

describe("integration / persistence: every new column is written", () => {
  it("persists field_provenance, voter_used, ocr_layer_used, validator fields, extraction_kind", async () => {
    const svc = buildSvc();
    await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc,
      settings: { docai_provider_order: ["claude", "reducto"] },
      bytes: Buffer.from("PDF text ".repeat(30)),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: null, kind: "po",
      vote: true,
    });
    // The mock svc's update() logs are stored via repeated push;
    // we can scan the extraction_runs table for an update call
    // that carries the new columns.
    const runs = svc._tables.get("extraction_runs") || [];
    expect(runs.length).toBeGreaterThan(0);
    // The shim stores both insert + update on the same array. Find
    // any record that contains the new columns.
    const lastWrite = runs[runs.length - 1];
    // The update payload's keys we want present:
    const expectedKeys = [
      "validator_issues", "validator_summary",
      "text_layer_used", "ocr_layer_used", "template_used",
      "overrides_applied", "field_provenance", "voter_lines", "voter_used",
    ];
    for (const k of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(lastWrite, k)).toBe(true);
    }
    // extraction_kind is set on insert (the first row).
    const firstRow = runs[0];
    expect(firstRow.extraction_kind).toBe("po");
  });
});
