// Regression test for the re-extraction source_id -> bytes resolver
// in src/api/docai/extract.js.
//
// Bug: the SO workspace "run extraction" button POSTs only
// { source_id, order_id } -- no bytes_base64, because the PO file is
// no longer in the browser. The endpoint used to pass bytes=null
// straight to runExtractionPipeline, the pipeline never populated
// bodyText, and the Claude adapter died with the cryptic
// "needs hints.bodyText, bytes (PDF/image/text), or url".
//
// Fix: when no bytes/url/bodyText is supplied but a document handle
// is, resolve the storage object server-side and feed its bytes in.
// Return a clean 400 (NO_SOURCE_BYTES) when the doc can't be resolved.
//
// These tests assert the three behaviours that matter:
//   1. source_id-only  -> storage is read, pipeline gets real bytes
//   2. unresolvable id  -> 400 NO_SOURCE_BYTES, pipeline NOT called
//   3. bytes provided   -> storage is NOT touched (existing path intact)

import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared, mutable mock state. vi.hoisted runs before the vi.mock
// factories so they can close over these handles.
const h = vi.hoisted(() => ({
  documentRow: null, // what .from("documents")...maybeSingle() returns
  signedUrlResult: { data: { signedUrl: "https://storage.test/signed/po.pdf" }, error: null },
  fetchOk: true,
  fetchBytes: Buffer.from("%PDF-1.7 fake pdf bytes"),
  pipelineCalls: [], // captures every runExtractionPipeline arg
  downloadCalls: [], // captures storage.createSignedUrl(path, ttl)
  documentsQuery: null, // captures the eq filters used on documents
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));

vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: vi.fn(async () => ({})),
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
}));

vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: vi.fn(async () => ({
    ok: h.fetchOk,
    status: h.fetchOk ? 200 : 404,
    arrayBuffer: async () => h.fetchBytes,
  })),
}));

vi.mock("../api/_lib/docai/run.js", () => ({
  runExtractionPipeline: vi.fn(async (args) => {
    h.pipelineCalls.push(args);
    return {
      runId: "run-1", status: "ok", statusReason: "ok",
      adapterUsed: "claude", adapterMode: "pdf_document",
      confidenceOverall: 0.9, normalized: { lines: [] }, attempts: [],
      textLayer: null,
    };
  }),
}));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({
    from: (table) => {
      const q = {
        _table: table,
        _eq: {},
        select: () => q,
        eq: (k, v) => { q._eq[k] = v; return q; },
        maybeSingle: async () => {
          if (table === "documents") {
            h.documentsQuery = { ...q._eq };
            return { data: h.documentRow, error: null };
          }
          return { data: null, error: null };
        },
      };
      return q;
    },
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path, ttl) => {
          h.downloadCalls.push({ bucket, path, ttl });
          return h.signedUrlResult;
        },
      }),
    },
  })),
}));

// Import AFTER the mocks are registered.
const { default: handler } = await import("../api/docai/extract.js");

const makeRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(obj) { this.body = JSON.stringify(obj); return this; },
    end() { return this; },
  };
  return res;
};

const run = async (body) => {
  const req = { method: "POST", headers: {}, body };
  const res = makeRes();
  await handler(req, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = res.body; }
  return { res, parsed };
};

beforeEach(() => {
  h.documentRow = {
    storage_bucket: "obara-documents",
    storage_path: "t-1/po-250432265.pdf",
    mime_type: "application/pdf",
    filename: "P250432265.pdf",
  };
  h.signedUrlResult = { data: { signedUrl: "https://storage.test/signed/po.pdf" }, error: null };
  h.fetchOk = true;
  h.fetchBytes = Buffer.from("%PDF-1.7 fake pdf bytes");
  h.pipelineCalls = [];
  h.downloadCalls = [];
  h.documentsQuery = null;
});

describe("docai/extract re-extraction source_id resolver", () => {
  it("resolves bytes from storage when only source_id is provided", async () => {
    const { res } = await run({ source_id: "doc-1", order_id: "ord-1" });
    expect(res.statusCode).toBe(200);
    // storage was consulted, scoped to the tenant + the doc id
    expect(h.downloadCalls).toHaveLength(1);
    expect(h.downloadCalls[0]).toMatchObject({ bucket: "obara-documents", path: "t-1/po-250432265.pdf" });
    expect(h.documentsQuery).toMatchObject({ tenant_id: "t-1", id: "doc-1" });
    // the pipeline received real bytes + the resolved mime/filename
    expect(h.pipelineCalls).toHaveLength(1);
    const call = h.pipelineCalls[0];
    expect(Buffer.isBuffer(call.bytes)).toBe(true);
    expect(call.bytes.length).toBeGreaterThan(0);
    expect(call.mime).toBe("application/pdf");
    expect(call.filename).toBe("P250432265.pdf");
    expect(call.sourceType).toBe("pdf");
  });

  it("routes an image document to sourceType=image from the resolved mime", async () => {
    h.documentRow = {
      storage_bucket: "obara-documents",
      storage_path: "t-1/po-photo.png",
      mime_type: "image/png",
      filename: "po-photo.png",
    };
    const { res } = await run({ source_id: "doc-img", order_id: "ord-1" });
    expect(res.statusCode).toBe(200);
    expect(h.pipelineCalls[0].sourceType).toBe("image");
  });

  it("returns 400 NO_SOURCE_BYTES (not the adapter error) for an unresolvable id", async () => {
    h.documentRow = null; // no matching documents row
    const { res, parsed } = await run({ source_id: "ghost", order_id: "ord-1" });
    expect(res.statusCode).toBe(400);
    expect(parsed?.error?.code).toBe("NO_SOURCE_BYTES");
    // the pipeline must NOT run when we have nothing to feed it
    expect(h.pipelineCalls).toHaveLength(0);
  });

  it("returns 400 when storage download fails (signed-url fetch not ok)", async () => {
    h.fetchOk = false;
    const { res, parsed } = await run({ source_id: "doc-1", order_id: "ord-1" });
    expect(res.statusCode).toBe(400);
    expect(parsed?.error?.code).toBe("NO_SOURCE_BYTES");
    expect(h.pipelineCalls).toHaveLength(0);
  });

  it("does NOT touch storage when bytes_base64 is supplied (existing intake path intact)", async () => {
    const b64 = Buffer.from("%PDF-1.7 real upload").toString("base64");
    const { res } = await run({ bytes_base64: b64, mime: "application/pdf", source_filename: "u.pdf" });
    expect(res.statusCode).toBe(200);
    expect(h.downloadCalls).toHaveLength(0); // storage never consulted
    expect(h.pipelineCalls).toHaveLength(1);
    expect(Buffer.isBuffer(h.pipelineCalls[0].bytes)).toBe(true);
  });

  it("returns 400 when no document handle and no bytes/url/bodyText at all", async () => {
    const { res, parsed } = await run({ order_id: "ord-1" });
    expect(res.statusCode).toBe(400);
    expect(parsed?.error?.code).toBe("NO_SOURCE_BYTES");
    expect(h.downloadCalls).toHaveLength(0);
    expect(h.pipelineCalls).toHaveLength(0);
  });

  it("skips storage resolution when hints.bodyText is provided", async () => {
    const { res } = await run({ source_id: "doc-1", hints: { bodyText: "PO Number: X\nGSTIN: Y" } });
    expect(res.statusCode).toBe(200);
    expect(h.downloadCalls).toHaveLength(0); // bodyText is enough; don't read storage
    expect(h.pipelineCalls).toHaveLength(1);
  });
});
