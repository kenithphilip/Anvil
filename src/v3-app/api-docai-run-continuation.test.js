// The sync pipeline folds continuation rows before anything reads the lines.
//
// runExtractionPipeline is driven for real with the dispatcher stubbed to
// return what a shredding extractor returns for a multi-row PO: each item's
// part row as a line, then its description, drawing-code and requisition rows
// as lines of their own with no quantity. What the caller gets back, and what
// is persisted on the run, must be one line per printed item.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ body: "" }));

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async () => ({
    ok: true, status: "has_text", page_count: 2, char_count: H.body.length, body_text: H.body,
    page_breakdown: [], extractor: "unpdf", extractor_version: "test", latency_ms: 1, error: null,
  })),
  extractTextBlocks: vi.fn(async () => null),
  contentHash: vi.fn(async () => "fixture_hash_continuation"),
}));

vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async () => ({ ok: false, status: "failed", page_count: 0, char_count: 0, body_text: null, raw_pages: [], error: "stubbed" })),
}));

const ITEMS = [
  { part: "ZX-1001-A", qty: 4, rate: 250, desc: "GUIDE BLOCK", spec: "DRW-77-01", req: "4400011122" },
  { part: "ZX-1002-B", qty: 2, rate: 1200.5, desc: "CLAMP ARM", spec: "DRW-77-02", req: "4400011122" },
  { part: "ZX-1003-C", qty: 10, rate: 19.75, desc: "SPACER RING", spec: "DRW-77-09", req: "4400033344" },
];

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async () => {
    const lines = [];
    for (const it of ITEMS) {
      lines.push({ partNumber: it.part, quantity: it.qty, unitPrice: it.rate });
      lines.push({ partNumber: it.desc, quantity: null, unitPrice: it.qty * it.rate });
      lines.push({ partNumber: it.spec, quantity: null, unitPrice: null });
      lines.push({ partNumber: it.req, quantity: null, unitPrice: null });
    }
    const confidences = { overall: 0.9 };
    lines.forEach((_l, i) => { confidences["lines[" + i + "]"] = 0.9; });
    return {
      ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences,
      normalized: { classification: "po", customer: { name: "Fixture Buyer", currency: "INR" }, lines, stated_line_count: 3 },
      attempts: [{ adapter: "gemini", status: "ok" }], mode: "pre_extracted_text",
    };
  }),
  buildPromptOverrides: () => null,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

const { runExtractionPipeline } = await import("../api/_lib/docai/run.js");
const audit = await import("../api/_lib/audit.js");

// Minimal Supabase double: remembers every write, reads nothing back.
const makeSvc = () => {
  const writes = [];
  const svc = {
    writes,
    from(table) {
      const ctx = { table, values: null };
      const api = {
        select() { return api; },
        eq() { return api; }, in() { return api; }, is() { return api; },
        gte() { return api; }, lte() { return api; }, order() { return api; }, limit() { return api; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        update(values) { ctx.values = values; writes.push({ table, op: "update", values }); return api; },
        upsert(values) { writes.push({ table, op: "upsert", values }); return Promise.resolve({ data: null, error: null }); },
        insert(values) {
          writes.push({ table, op: "insert", values });
          const row = { id: table === "extraction_runs" ? "run-1" : "id-x", ...values };
          return {
            select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
            then: (resolve) => { resolve({ data: [row], error: null }); return { catch: () => ({}) }; },
          };
        },
        then(resolve) { resolve({ data: [], error: null }); return { catch: () => ({}) }; },
      };
      return api;
    },
  };
  return svc;
};

const run = (svc, settings = {}) => runExtractionPipeline({
  ctx: { tenantId: "t1", user: { id: "u1" } },
  svc,
  settings,
  bytes: Buffer.from("%PDF-1.4 fake"),
  filename: "po.pdf",
  mime: "application/pdf",
  sourceType: "pdf",
  kind: "po",
});

const finalRunWrite = (svc) => svc.writes
  .filter((w) => w.table === "extraction_runs" && w.op === "update" && w.values?.normalized_extract)
  .at(-1)?.values;

beforeEach(() => {
  vi.clearAllMocks();
  H.body = "PURCHASE ORDER\nFixture Buyer\nTotal Amount : INR 3,598.50\nItem No Qty Ex Price\n";
});

describe("runExtractionPipeline folds continuation rows", () => {
  it("returns one line per printed item, with each item's text on it", async () => {
    const result = await run(makeSvc());
    expect(result.status).toBe("ok");
    expect(result.normalized.lines.map((l) => [l.partNumber, l.quantity, l.unitPrice])).toEqual([
      ["ZX-1001-A", 4, 250], ["ZX-1002-B", 2, 1200.5], ["ZX-1003-C", 10, 19.75],
    ]);
    expect(result.normalized.lines[2].description).toBe("SPACER RING | DRW-77-09 | 4400033344");
  });

  it("persists the folded lines, and per-line confidences re-keyed to them", async () => {
    const svc = makeSvc();
    await run(svc);
    const w = finalRunWrite(svc);
    expect(w.normalized_extract.lines).toHaveLength(3);
    expect(Object.keys(w.field_confidences).filter((k) => /^lines\[\d+\]$/.test(k)).sort())
      .toEqual(["lines[0]", "lines[1]", "lines[2]"]);
    expect(w.normalized_extract.continuation_folds).toMatchObject({ rows_folded: 9, lines_before: 12, lines_after: 3 });
  });

  it("reports the fold, checks the document total, and records an event", async () => {
    const result = await run(makeSvc());
    const codes = result.anomalies.map((a) => a.code);
    expect(codes).toContain("continuation_rows_folded");
    expect(codes).not.toContain("continuation_fold_total_mismatch");
    expect(codes).not.toContain("line_count_excess");
    const events = audit.recordEvent.mock.calls.map((c) => c[1]?.eventType);
    expect(events).toContain("docai_continuation_rows_folded");
  });

  it("flags the folded lines when they do not add up to the printed total", async () => {
    H.body = "PURCHASE ORDER\nFixture Buyer\nTotal Amount : INR 2,000.00\nItem No Qty Ex Price\n";
    const result = await run(makeSvc());
    expect(result.anomalies.map((a) => a.code)).toContain("continuation_fold_total_mismatch");
  });

  it("docai_fold_continuation_rows=false leaves the lines as extracted, and the surplus is flagged", async () => {
    const result = await run(makeSvc(), { docai_fold_continuation_rows: false });
    expect(result.normalized.lines).toHaveLength(12);
    expect(result.anomalies.map((a) => a.code)).toContain("line_count_excess");
  });

  it("a non-PO kind is not folded", async () => {
    const result = await runExtractionPipeline({
      ctx: { tenantId: "t1", user: { id: "u1" } }, svc: makeSvc(), settings: {},
      bytes: Buffer.from("%PDF-1.4 fake"), filename: "q.pdf", mime: "application/pdf", sourceType: "pdf",
      kind: "generic",
    });
    expect(result.normalized.lines).toHaveLength(12);
  });
});
