// Regression test for the large-PDF sync->background routing in
// src/api/docai/extract.js.
//
// A long PO (e.g. P250432276, 23 pages) used to run the full
// synchronous chunked path -- TOC profiler + ceil(pages/5) sequential
// LLM calls -- which exceeds Vercel's 60s function limit and times out
// with nothing returned (no customer, no lines). The background worker
// only triggered above 60 pages, leaving a 12-60pp dead zone.
//
// Fix history: chunk extraction now runs in bounded-concurrency waves, so the
// sync path handles many more pages inside the 60s ceiling. BACKGROUND_PAGE_
// THRESHOLD was therefore raised from 12 to 40 — a 13-40pp PO (the common
// multi-page Mahindra PO) extracts ALL lines synchronously instead of
// down-scoping to page 1 + the cron-dependent background worker. Only >40pp
// still down-scopes to page-1-only + large_pdf.
//
// These tests assert:
//   1. >40pp  -> large_pdf true, total_pages set, pipeline got keepPages=[1]
//   2. 13-40pp-> large_pdf false, full sync path (the regression fix)
//   3. <=12pp -> large_pdf false, no keepPages down-scoping
//   4. body.no_background -> never down-scoped (the cron worker path)

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pageCount: 5,
  pipelineCalls: [],
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: vi.fn(async () => ({})) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/safe-fetch.js", () => ({ safeFetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("x") })) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  })),
}));
vi.mock("../api/_lib/docai/pdf-chunker.js", () => ({
  probePdfPageCount: vi.fn(async () => h.pageCount),
}));
vi.mock("../api/_lib/docai/run.js", () => ({
  runExtractionPipeline: vi.fn(async (args) => {
    h.pipelineCalls.push(args);
    return {
      runId: "run-1", status: "ok", statusReason: "ok", adapterUsed: "claude",
      adapterMode: "pdf_document", confidenceOverall: 0.9,
      normalized: { customer: { name: "Meridian Motor India Ltd" }, lines: [{}] },
      attempts: [], textLayer: null,
    };
  }),
}));

const { default: handler } = await import("../api/docai/extract.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const run = async (body) => {
  const req = { method: "POST", headers: {}, body };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

const pdfBytesB64 = Buffer.from("%PDF-1.7 fake").toString("base64");

beforeEach(() => {
  h.pageCount = 5;
  h.pipelineCalls = [];
});

describe("docai/extract large-PDF routing", () => {
  it("down-scopes a >40-page PDF to page 1 and flags large_pdf", async () => {
    h.pageCount = 45;
    const { res, parsed } = await run({ bytes_base64: pdfBytesB64, mime: "application/pdf", source_filename: "po.pdf" });
    expect(res.statusCode).toBe(200);
    expect(parsed.large_pdf).toBe(true);
    expect(parsed.total_pages).toBe(45);
    expect(h.pipelineCalls).toHaveLength(1);
    expect(h.pipelineCalls[0].hints.keepPages).toEqual([1]);
    // customer still detected from the page-1 header
    expect(parsed.normalized.customer.name).toMatch(/Meridian/);
  });

  it("extracts a 13-40pp PO fully on the sync path (regression: no page-1 down-scope)", async () => {
    // A 23-page PO (e.g. P250432276) used to down-scope to page 1 + background;
    // with concurrent-wave chunking it now extracts ALL pages synchronously.
    h.pageCount = 23;
    const { parsed } = await run({ bytes_base64: pdfBytesB64, mime: "application/pdf", source_filename: "po.pdf" });
    expect(parsed.large_pdf).toBe(false);
    expect(h.pipelineCalls[0].hints.keepPages).toBeUndefined();
  });

  it("leaves a <=12-page PDF on the full sync path (no down-scope)", async () => {
    h.pageCount = 7;
    const { res, parsed } = await run({ bytes_base64: pdfBytesB64, mime: "application/pdf", source_filename: "po.pdf" });
    expect(res.statusCode).toBe(200);
    expect(parsed.large_pdf).toBe(false);
    expect(h.pipelineCalls[0].hints.keepPages).toBeUndefined();
  });

  it("never down-scopes when body.no_background is set (cron worker path)", async () => {
    h.pageCount = 99;
    const { parsed } = await run({ bytes_base64: pdfBytesB64, mime: "application/pdf", no_background: true });
    expect(parsed.large_pdf).toBe(false);
    expect(h.pipelineCalls[0].hints.keepPages).toBeUndefined();
  });

  it("does not probe / down-scope non-PDF sources", async () => {
    h.pageCount = 99; // would be 'large' if probed
    const { parsed } = await run({ bytes_base64: pdfBytesB64, mime: "image/png", source_filename: "po.png" });
    expect(parsed.large_pdf).toBe(false);
    expect(h.pipelineCalls[0].hints.keepPages).toBeUndefined();
  });
});
