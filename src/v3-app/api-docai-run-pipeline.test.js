// Phase F.3: integration test for runExtractionPipeline.
//
// We stub everything the pipeline talks to:
//   - svc (Supabase) -> in-memory shim that returns canned rows.
//   - text_layer.extractTextLayer -> returns a fixture so we don't
//     try to import unpdf.
//   - voter / overrides / templates -> imported as-is (pure code).
//
// The goal is to confirm that the pipeline orchestrates the layers
// in the right order:
//   - opens an extraction_runs row
//   - runs L1 text layer
//   - applies the customer template
//   - calls dispatchExtract
//   - applies overrides
//   - runs validators
//   - persists final state with status_reason

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We mock the modules that perform I/O. vi.mock hoists, so all
// referenced names need to be re-created inside the factory.
vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async () => ({
    ok: true, status: "has_text",
    page_count: 1, char_count: 500,
    body_text: "PO Number: PO-AAA-100\nGSTIN: 27AAACA1234B1Z5",
    page_breakdown: [{ page: 1, chars: 500, has_text: true }],
    extractor: "unpdf", extractor_version: "test", latency_ms: 5,
    error: null,
  })),
  contentHash: vi.fn(async () => "fixture_hash"),
  looksLikePdf: () => true,
  TEXT_LAYER_THRESHOLDS: { usable: 200, perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async () => ({
    ok: false, status: "failed",
    page_count: 0, char_count: 0, body_text: null, page_breakdown: [],
    bbox_count: 0, provider: "mistral", provider_model: null,
    latency_ms: 1, raw_pages: [], error: "stubbed",
  })),
  OCR_LAYER_THRESHOLDS: { perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async ({ hints }) => ({
    ok: true,
    adapter_used: "claude",
    confidence_overall: 0.92,
    confidences: { overall: 0.92 },
    normalized: {
      classification: "po",
      customer: { name: "Acme", gstin: "27AAACA1234B1Z5", currency: "INR" },
      lines: [{ partNumber: "X", quantity: 5, unitPrice: 100, hsn: "8482", gst_pct: 18 }],
    },
    raw: { hint_body_text_chars: hints?.bodyText?.length || 0 },
    attempts: [{ adapter: "claude", status: "ok" }],
    mode: "pre_extracted_text",
  })),
  buildPromptOverrides: () => null,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

import { runExtractionPipeline } from "../api/_lib/docai/run.js";

const buildSvc = (storage) => ({
  from: (table) => {
    const ctx = { table, filters: [] };
    const api = {
      select(_c, _o) { return api; },
      eq(c, v) { ctx.filters.push({ c, op: "eq", v }); return api; },
      in(c, v) { ctx.filters.push({ c, op: "in", v }); return api; },
      is(c, v) { ctx.filters.push({ c, op: "is", v }); return api; },
      gte(c, v) { ctx.filters.push({ c, op: "gte", v }); return api; },
      lte(c, v) { ctx.filters.push({ c, op: "lte", v }); return api; },
      order(c) { ctx.order = c; return api; },
      limit(n) { ctx.limit = n; return api; },
      maybeSingle() {
        const rows = storage.read(ctx);
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        const rows = storage.read(ctx);
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "no row" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve) { resolve({ data: storage.read(ctx), error: null }); return { catch: () => ({}) }; },
      update(values) { ctx.action = "update"; ctx.values = values; storage.write(ctx); return api; },
      insert(values) {
        ctx.action = "insert"; ctx.values = values;
        const inserted = storage.insert(ctx);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: inserted, error: null }),
          }),
          then: (resolve) => { resolve({ data: [inserted], error: null }); return { catch: () => ({}) }; },
        };
      },
      upsert(values, _opts) {
        ctx.action = "upsert"; ctx.values = values;
        storage.upsert(ctx);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return api;
  },
});

const makeStorage = () => {
  const tables = new Map();
  let runIdCounter = 1;
  const get = (t) => tables.get(t) || [];
  return {
    tables,
    insert(ctx) {
      const list = get(ctx.table);
      const id = ctx.table === "extraction_runs" ? "run-" + (runIdCounter++) : "id-" + Math.random();
      const row = { id, ...ctx.values };
      list.push(row); tables.set(ctx.table, list);
      return row;
    },
    upsert(ctx) {
      const list = get(ctx.table);
      list.push({ id: "id-" + Math.random(), ...ctx.values });
      tables.set(ctx.table, list);
    },
    write(ctx) {
      const list = get(ctx.table);
      // For simplicity treat update as appending; tests inspect tables[]
      list.push({ _update_for: ctx.filters, ...ctx.values });
      tables.set(ctx.table, list);
    },
    read(ctx) {
      // In-memory rows when present; otherwise empty.
      // For extraction_text_layer + extraction_ocr_layer we want a
      // miss so the pipeline runs the (mocked) extractors fresh.
      if (ctx.table === "extraction_text_layer") return [];
      if (ctx.table === "extraction_ocr_layer") return [];
      if (ctx.table === "customer_format_templates") return [];
      if (ctx.table === "customer_field_overrides") return [];
      return get(ctx.table);
    },
  };
};

describe("runExtractionPipeline / happy path", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("runs L1 -> dispatch -> L5 and persists status=ok with run_id", async () => {
    const storage = makeStorage();
    const svc = buildSvc(storage);
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc,
      settings: {},
      bytes: Buffer.from("%PDF-1.4 fake"),
      url: null,
      filename: "po.pdf",
      mime: "application/pdf",
      sourceType: "pdf",
      customerId: "c1",
      documentId: "11111111-1111-1111-1111-111111111111",
      sourceId: "11111111-1111-1111-1111-111111111111",
      caseId: "ord-1",
      kind: "po",
    });

    expect(result.runId).toMatch(/^run-/);
    expect(result.status).toBe("ok");
    expect(result.statusReason).toBe("ok");
    expect(result.adapterUsed).toBe("claude");
    expect(result.textLayerUsed).toBe(true);
    expect(result.confidenceOverall).toBeGreaterThan(0.7);
    expect(result.normalized.lines).toHaveLength(1);
    expect(result.normalized.customer.gstin).toBe("27AAACA1234B1Z5");

    // Persistence: at least one extraction_runs row inserted +
    // updated; at least one text-layer upsert.
    expect(storage.tables.has("extraction_runs")).toBe(true);
    const txtRows = storage.tables.get("extraction_text_layer") || [];
    expect(txtRows.length).toBeGreaterThanOrEqual(1);
  });

  it("Wave 1.3: short-circuits when a recent run shares the content_hash + customer + kind", async () => {
    // Seed an extraction_runs row that the dedupe gate will find.
    // The text_layer mock returns contentHash="fixture_hash", so we
    // pre-stamp the prior run with the same hash.
    const storage = makeStorage();
    const prior = {
      id: "run-prior",
      tenant_id: "t1",
      customer_id: "c1",
      content_hash: "fixture_hash",
      extraction_kind: "po",
      status: "ok",
      adapter_used: "gemini",
      normalized_extract: { classification: "po", lines: [{ partNumber: "PRIOR", quantity: 1, unitPrice: 10 }] },
      field_confidences: { overall: 0.91 },
      confidence_overall: 0.91,
      created_at: new Date().toISOString(),
      validator_issues: [],
      validator_summary: {},
      adapter_attempts: [],
      raw_extract: { from_prior: true },
      text_layer_used: true,
      ocr_layer_used: false,
      template_used: null,
      global_template_used: null,
      global_template_use_mode: null,
      overrides_applied: [],
      field_provenance: [],
      voter_used: false,
      selected_model: "gemini-2.5-flash",
      model_selection_reason: "prior",
      parse_method: "native_structured",
      parse_repairs: [],
      parse_retries: 0,
    };
    storage.tables.set("extraction_runs", [prior]);

    const dispatcher = await import("../api/_lib/docai/index.js");
    const svc = buildSvc(storage);
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc, settings: {},
      bytes: Buffer.from("%PDF-1.4 fake"),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: "c1",
      kind: "po",
    });

    expect(result.status).toBe("ok");
    expect(result.statusReason).toBe("dedupe_hit");
    expect(result.dedupeOf).toBe("run-prior");
    expect(result.adapterUsed).toBe("gemini");
    expect(result.normalized.lines[0].partNumber).toBe("PRIOR");
    expect(result.confidenceOverall).toBe(0.91);
    // L4 dispatch must NOT have been called.
    expect(dispatcher.dispatchExtract).not.toHaveBeenCalled();
  });

  it("Wave 1.3: dedupe respects docai_content_dedupe_minutes=0 opt-out", async () => {
    const storage = makeStorage();
    storage.tables.set("extraction_runs", [{
      id: "run-prior",
      tenant_id: "t1",
      customer_id: "c1",
      content_hash: "fixture_hash",
      extraction_kind: "po",
      status: "ok",
      created_at: new Date().toISOString(),
      normalized_extract: { lines: [] },
      confidence_overall: 0.9,
    }]);
    const dispatcher = await import("../api/_lib/docai/index.js");
    const svc = buildSvc(storage);
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc,
      settings: { docai_content_dedupe_minutes: 0 },          // disabled
      bytes: Buffer.from("%PDF-1.4 fake"),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: "c1",
      kind: "po",
    });
    expect(result.statusReason).not.toBe("dedupe_hit");
    expect(dispatcher.dispatchExtract).toHaveBeenCalled();
  });

  it("derives status_reason='low_confidence' when adjusted confidence drops below 0.7", async () => {
    // Configure the dispatcher mock to return malformed GSTIN so
    // validators downgrade to <0.7.
    const dispatcher = await import("../api/_lib/docai/index.js");
    dispatcher.dispatchExtract.mockResolvedValueOnce({
      ok: true,
      adapter_used: "claude",
      confidence_overall: 0.95,
      confidences: { overall: 0.95 },
      normalized: {
        classification: "po",
        customer: { name: "Acme", gstin: "INVALID", currency: "INR" },
        lines: [{ partNumber: "X", quantity: 5, unitPrice: 100 }],
      },
      raw: {},
      attempts: [{ adapter: "claude", status: "ok" }],
      mode: "pre_extracted_text",
    });
    const storage = makeStorage();
    const svc = buildSvc(storage);
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", userId: "u1" },
      svc, settings: {},
      bytes: Buffer.from("%PDF-1.4 fake"),
      filename: "po.pdf", mime: "application/pdf",
      sourceType: "pdf", customerId: null,
      kind: "po",
    });
    expect(result.status).toBe("low_confidence");
    expect(result.statusReason).toBe("low_confidence");
    expect(result.validatorSummary.error).toBeGreaterThanOrEqual(1);
  });
});
