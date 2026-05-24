// Regression test for the large-PDF sync->background routing in
// src/api/docai/extract.js.
//
// A long PO (e.g. P250432276, 23 pages) used to run the full
// synchronous chunked path -- TOC profiler + ceil(pages/5) sequential
// LLM calls -- which exceeds Vercel's 60s function limit and times out
// with nothing returned (no customer, no lines). The background worker
// only triggered above 60 pages, leaving a 12-60pp dead zone.
//
// Fix: for PDFs over BACKGROUND_PAGE_THRESHOLD (12) the endpoint runs
// a page-1-only sync extraction (customer header + preview, fast) and
// returns large_pdf=true so the caller enqueues the full background
// job. Short PDFs are unchanged.
//
// These tests assert:
//   1. >12pp  -> large_pdf true, total_pages set, pipeline got
//                hints.keepPages = [1]
//   2. <=12pp -> large_pdf false, no keepPages down-scoping
//   3. body.no_background -> never down-scoped (the cron worker path)

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
      normalized: { customer: { name: "Hyundai Motor India Ltd" }, lines: [{}] },
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
  it("down-scopes a >12-page PDF to page 1 and flags large_pdf", async () => {
    h.pageCount = 23;
    const { res, parsed } = await run({ bytes_base64: pdfBytesB64, mime: "application/pdf", source_filename: "po.pdf" });
    expect(res.statusCode).toBe(200);
    expect(parsed.large_pdf).toBe(true);
    expect(parsed.total_pages).toBe(23);
    expect(h.pipelineCalls).toHaveLength(1);
    expect(h.pipelineCalls[0].hints.keepPages).toEqual([1]);
    // customer still detected from the page-1 header
    expect(parsed.normalized.customer.name).toMatch(/Hyundai/);
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
