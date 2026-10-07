// The background worker folds continuation rows before it writes an order.
//
// A PO over the background page threshold never passes through run.js, so the
// worker's MERGING stage has to run the same fold itself. It runs on the
// merged line set, so an item's continuation rows that landed at the start of
// the NEXT chunk still join it.
//
// Every value is invented.

import { describe, it, expect, vi } from "vitest";

vi.mock("../api/_lib/audit.js", () => ({ recordEvent: vi.fn(async () => {}), recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: vi.fn(async () => ({})) }));

const { __test } = await import("../api/cron/extraction_jobs.js");
const { tenantSettings } = await import("../api/_lib/stripe-client.js");
const { advanceJob } = __test;

// Supabase double: records every update, and answers the cancel check with
// the job's own status.
const makeSvc = (job) => {
  const updates = [];
  return {
    updates,
    from(table) {
      const ctx = { table, values: null };
      const api = {
        select() { return api; },
        eq() { return api; },
        neq() { return api; },
        order() { return api; },
        limit() { return api; },
        update(v) { ctx.values = v; updates.push({ table, values: v }); return api; },
        maybeSingle: async () => {
          if (ctx.values) return { data: { ...job, ...ctx.values }, error: null };
          if (table === "extraction_jobs") return { data: { status: job.status }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: { ...job, ...(ctx.values || {}) }, error: null }),
        then: (r) => r({ data: [], error: null }),
      };
      return api;
    },
  };
};

const chunk = (lines) => ({
  ok: true, adapter_used: "gemini", confidence_overall: 0.9,
  confidences: Object.fromEntries([["overall", 0.9], ...lines.map((_l, i) => ["lines[" + i + "]", 0.9])]),
  normalized: { classification: "po", customer: { name: "Fixture Buyer" }, lines, stated_line_count: 2 },
  attempts: [],
});

const mergingJob = (kind, chunkResults) => ({
  id: "job-1", tenant_id: "t-1", order_id: "ord-1", customer_id: null, document_id: null,
  extraction_kind: kind, status: "merging",
  chunk_status: chunkResults.map((_r, i) => ({ index: i, page_start: i * 5 + 1, page_end: i * 5 + 5, page_count: 5, status: "done", attempts: 1 })),
  partial_result: { chunk_results: chunkResults },
});

// Item 1's description and drawing-code rows sit at the end of chunk 1; its
// requisition row spilled onto the next page, the first row of chunk 2.
const CHUNKS = [
  chunk([
    { partNumber: "ZX-1001-A", quantity: 4, unitPrice: 250 },
    { partNumber: "GUIDE BLOCK", unitPrice: 1000 },
    { partNumber: "DRW-77-01" },
  ]),
  chunk([
    { partNumber: "4400011122" },
    { partNumber: "ZX-1002-B", quantity: 2, unitPrice: 1200.5 },
    { partNumber: "CLAMP ARM" },
  ]),
];

const writtenLines = (svc) => svc.updates.find((u) => u.table === "orders")?.values?.result?.salesOrder?.lineItems;

describe("background merge folds continuation rows", () => {
  it("writes one line per printed item, including across a chunk boundary", async () => {
    const job = mergingJob("po", CHUNKS);
    const svc = makeSvc(job);
    const { job: done } = await advanceJob(svc, job);
    expect(done.status).toBe("completed");
    const lines = writtenLines(svc);
    expect(lines.map((l) => [l.partNumber, l.quantity, l.unitPrice])).toEqual([
      ["ZX-1001-A", 4, 250], ["ZX-1002-B", 2, 1200.5],
    ]);
    expect(lines[0].description).toBe("GUIDE BLOCK | DRW-77-01 | 4400011122");
    expect(lines[1].description).toBe("CLAMP ARM");
  });

  it("stores the folded result, with per-line confidences re-keyed to the folded lines", async () => {
    // One chunk, so the per-line keys start out aligned with the lines.
    const job = mergingJob("po", [chunk([
      ...CHUNKS[0].normalized.lines,
      ...CHUNKS[1].normalized.lines,
    ])]);
    const svc = makeSvc(job);
    await advanceJob(svc, job);
    const result = svc.updates.find((u) => u.table === "extraction_jobs" && u.values.status === "completed").values.result;
    expect(result.normalized.lines).toHaveLength(2);
    expect(result.normalized.continuation_folds).toMatchObject({ rows_folded: 4, lines_before: 6, lines_after: 2 });
    expect(Object.keys(result.confidences).filter((k) => k.startsWith("lines[")).sort()).toEqual(["lines[0]", "lines[1]"]);
  });

  it("honours the tenant switch docai_fold_continuation_rows=false", async () => {
    tenantSettings.mockResolvedValueOnce({ docai_fold_continuation_rows: false });
    const job = mergingJob("po", CHUNKS);
    const svc = makeSvc(job);
    await advanceJob(svc, job);
    expect(writtenLines(svc)).toHaveLength(6);
  });

  it("drops the table's own header rows read as leading lines, even when nothing else folds", async () => {
    const job = mergingJob("po", [chunk([
      { lineNo: 0, quantity: 0, unitPrice: 0, customerItemCode: "Specification" },
      { lineNo: 1, partNumber: "ZX-1001-A", quantity: 4, unitPrice: 250 },
      { lineNo: 2, partNumber: "ZX-1002-B", quantity: 2, unitPrice: 1200.5 },
    ])]);
    const svc = makeSvc(job);
    await advanceJob(svc, job);
    expect(writtenLines(svc).map((l) => l.partNumber)).toEqual(["ZX-1001-A", "ZX-1002-B"]);
  });

  it("leaves an RFQ job's lines as extracted", async () => {
    const job = mergingJob("rfq", CHUNKS);
    const svc = makeSvc(job);
    await advanceJob(svc, job);
    expect(writtenLines(svc)).toHaveLength(6);
  });
});
