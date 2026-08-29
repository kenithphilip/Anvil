// Phase 3b: the background worker walks ROW WINDOWS, one per tick, for a
// line-dense document that page chunking cannot split.
//
// Drives advanceJob directly with a fake Supabase + mocked text layer and
// dispatcher, so the chunking stage (plan windows) and the extracting stage
// (re-derive window N and send it as TEXT) are exercised for real.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

const H = vi.hoisted(() => ({ dispatchCalls: [], body: null, pdf: null }));

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async () => ({
    ok: true, status: "has_text", page_count: 4,
    char_count: (H.body || "").length, body_text: H.body,
    page_breakdown: [], extractor: "unpdf", extractor_version: "t", latency_ms: 1, error: null,
  })),
}));

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async (args) => {
    H.dispatchCalls.push(args);
    const rows = (args.hints?.bodyText || "").split(/\r?\n/).filter((l) => /^\s*\d{1,4}[.)]?\s+\S/.test(l));
    return {
      ok: true, adapter_used: "claude", confidence_overall: 0.9, confidences: { overall: 0.9 },
      normalized: { classification: "quote", customer: { name: "Fiat India" }, lines: rows.map((_r, i) => ({ partNumber: "P" + i })) },
      attempts: [{ adapter: "claude", status: "ok" }],
    };
  }),
}));

vi.mock("../api/_lib/audit.js", () => ({ recordEvent: vi.fn(async () => {}), recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: vi.fn(async () => ({ docai_density_chunk_enabled: true })),
}));

const { __test } = await import("../api/cron/extraction_jobs.js");
const { advanceJob } = __test;

// 300 items -> 12 windows at 25/window: the "far too dense for one call" case.
const denseBody = (n = 300) => {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`  ${i}   ADAPTER   TNA-16-04-${i}   85159000   5 Nos 660 3300`);
  return ["PRICE QUOTATION", "TO: Fiat India Automobiles Limited", "",
    " Item  Part Name  PARTS NO.  HSN CODE  Qty Unit  Unit Price  Amount", "",
    ...rows, "", "Terms: ex-works"].join("\n");
};

// Minimal Supabase double: update() returns the merged row, storage returns bytes.
const makeSvc = () => {
  const svc = {
    updates: [],
    from(table) {
      const ctx = { table, values: null };
      const api = {
        select() { return api; },
        eq() { return api; },
        update(v) { ctx.values = v; return api; },
        insert(v) { ctx.values = v; return api; },
        maybeSingle: async () => {
          if (!ctx.values) return { data: null, error: null };   // a plain read
          svc.updates.push({ table, values: ctx.values });
          return { data: { ...svc.job, ...ctx.values }, error: null };
        },
        single: async () => {
          svc.updates.push({ table, values: ctx.values });
          return { data: { ...svc.job, ...ctx.values }, error: null };
        },
        then: (r) => r({ data: [], error: null }),
      };
      return api;
    },
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => H.pdf }, error: null }),
      }),
    },
  };
  return svc;
};

const baseJob = (over = {}) => ({
  id: "job-1", tenant_id: "t-1", order_id: "ord-1", customer_id: "c-1",
  storage_path: "docs/q.pdf", source_filename: "q.pdf", source_mime: "application/pdf",
  extraction_kind: "quote", total_pages: 4, keep_pages: null,
  chunk_status: [], partial_result: {}, next_chunk_index: 0, attempts: 0,
  ...over,
});

// A REAL 2-page PDF: the page-chunk fallback runs pdf-lib over these bytes.
let pdfBytes;
beforeAll(async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([300, 400]);
  const u8 = await doc.save();
  pdfBytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
});

beforeEach(() => { H.dispatchCalls = []; H.body = denseBody(); H.pdf = pdfBytes; });

describe("background worker / row-window chunking", () => {
  it("CHUNKING stage plans row windows (not page chunks) for a dense document", async () => {
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    expect(job.status).toBe("extracting");
    const list = job.chunk_status;
    expect(list.length).toBe(12);                    // 300 items / 25 per window
    expect(list.every((c) => c.mode === "row")).toBe(true);
    expect(list[0]).toMatchObject({ index: 0, mode: "row", status: "pending", attempts: 0 });
    expect(list[0].item_count).toBe(25);
    // Row windows are a TEXT artifact: no page ranges are recorded for them.
    expect(list[0].page_start).toBeUndefined();
  });

  it("EXTRACTING stage re-derives window N and sends it as TEXT with the bytes stripped", async () => {
    const svc = makeSvc();
    const chunkStatus = Array.from({ length: 12 }, (_v, i) => ({ index: i, mode: "row", item_count: 25, status: "pending", attempts: 0 }));
    // Ask for window 3 by marking 0..2 done.
    chunkStatus[0].status = "done"; chunkStatus[1].status = "done"; chunkStatus[2].status = "done";
    svc.job = baseJob({ status: "extracting", chunk_status: chunkStatus });
    await advanceJob(svc, svc.job);

    expect(H.dispatchCalls.length).toBe(1);
    const call = H.dispatchCalls[0];
    // TEXT mode, generation tier, and the window index carried for diagnostics.
    expect(typeof call.hints.bodyText).toBe("string");
    expect(call.hints.escalate).toBe(true);
    expect(call.hints.density_window).toBe(3);
    expect(call.hints.expectedKind).toBe("quote");
    // Bytes stripped so a byte-reading adapter can't extract the whole document.
    expect(call.source.bytes).toBeNull();
    expect(call.source.url).toBeNull();
    // It is window 3, not the whole table: items 76..100 of 300.
    expect(call.hints.bodyText).toContain("TNA-16-04-76 ");
    expect(call.hints.bodyText).not.toContain("TNA-16-04-1 ");
    expect(call.hints.bodyText.length).toBeLessThan(H.body.length);
    // The preamble + header ride along so the window is self-describing.
    expect(call.hints.bodyText).toContain("Fiat India");
    expect(call.hints.bodyText).toContain("PARTS NO.");
  });

  it("falls back to PAGE chunks when the document is not dense", async () => {
    H.body = ["QUOTATION", " Item Description Qty Rate", "  1  WIDGET  5  100"].join("\n");
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    const list = job.chunk_status;
    expect(list.some((c) => c.mode === "row")).toBe(false);
  });

  it("falls back to PAGE chunks when the density flag is off", async () => {
    const stripe = await import("../api/_lib/stripe-client.js");
    stripe.tenantSettings.mockResolvedValueOnce({});
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    expect((job.chunk_status || []).some((c) => c.mode === "row")).toBe(false);
  });
});

// Guards from the adversarial review: the dangerous failures all produce a
// SHORTER, in-range, plausible line set that would be written over the order.
describe("background worker / row-window safety guards", () => {
  it("refuses row mode on a MIXED (part-scanned) PDF -- the scanned rows would vanish", async () => {
    const tl = await import("../api/_lib/docai/text_layer.js");
    tl.extractTextLayer.mockResolvedValueOnce({
      ok: true, status: "mixed", page_count: 60,
      char_count: H.body.length, body_text: H.body, page_breakdown: [], error: null,
    });
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    expect((job.chunk_status || []).some((c) => c.mode === "row")).toBe(false);
  });

  it("refuses row mode when the text layer was TRUNCATED at the body-text cap", async () => {
    const tl = await import("../api/_lib/docai/text_layer.js");
    tl.extractTextLayer.mockResolvedValueOnce({
      ok: true, status: "has_text", page_count: 40,
      // char_count (pre-trim) exceeds the delivered body -> trimmed mid-table.
      char_count: H.body.length + 50_000, body_text: H.body, page_breakdown: [], error: null,
    });
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    expect((job.chunk_status || []).some((c) => c.mode === "row")).toBe(false);
  });

  it("refuses row mode when the profiler already restricted the job to keep_pages", async () => {
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking", keep_pages: [3, 4, 5] });
    const { job } = await advanceJob(svc, svc.job);
    expect((job.chunk_status || []).some((c) => c.mode === "row")).toBe(false);
  });

  it("PINS the plan at chunking time so later ticks can detect drift", async () => {
    const svc = makeSvc();
    svc.job = baseJob({ status: "chunking" });
    const { job } = await advanceJob(svc, svc.job);
    const pin = job.partial_result?.row_plan;
    expect(pin).toBeTruthy();
    expect(pin.window_count).toBe(12);
    expect(pin.item_count).toBe(300);
    expect(typeof pin.fingerprint).toBe("string");
  });

  it("FAILS a tick when the re-derived plan drifts from the pin (wrong rows, not fewer)", async () => {
    const svc = makeSvc();
    const chunkStatus = Array.from({ length: 12 }, (_v, i) => ({ index: i, mode: "row", item_count: 25, status: "pending", attempts: 0 }));
    svc.job = baseJob({
      status: "extracting", chunk_status: chunkStatus,
      partial_result: { row_plan: { window_count: 12, item_count: 300, fingerprint: "12:300:deadbeef" } },
    });
    await advanceJob(svc, svc.job);
    // The window was NOT dispatched, and the chunk records the drift.
    expect(H.dispatchCalls.length).toBe(0);
    const written = svc.updates.at(-1).values.chunk_status[0];
    expect(String(written.last_error || "")).toContain("ROW_PLAN_DRIFT");
  });

  it("MERGING refuses to write back when any row window failed (no partial line table)", async () => {
    const svc = makeSvc();
    const chunkStatus = Array.from({ length: 12 }, (_v, i) => ({ index: i, mode: "row", item_count: 25, status: "done", attempts: 1 }));
    chunkStatus[7].status = "failed";
    svc.job = baseJob({
      status: "merging", chunk_status: chunkStatus,
      partial_result: { chunk_results: chunkStatus.map(() => ({ ok: true, normalized: { classification: "quote", customer: { name: "Fiat" }, lines: [{ partNumber: "X" }] }, confidences: {}, attempts: [] })) },
    });
    const { job } = await advanceJob(svc, svc.job);
    expect(job.status).toBe("failed");
    expect(String(job.last_error)).toMatch(/row windows failed/);
  });
});
