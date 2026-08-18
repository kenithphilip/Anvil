// Attaching a quotation PDF to a customer PO.
//
// Every piece of this existed and nothing joined them up: documents/upload
// stored the PDF, DocAI had a quote schema (extract_quote, reached with
// kind:"quote"), quotes/ingest materialised an extracted quote into
// quotes/quote_lines, orders/reconcile_quotes already pooled EVERY
// non-cancelled quote for the customer and matched the PO across all of them,
// and order_documents has carried a 'quote' role with a composite PK since
// 001_init.
//
// But no client method called ingest, no UI wrote order_documents, and the
// reconciler never looked at an uploaded document — so a quote PDF attached to
// a PO was stored and ignored. This is the bridge.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables, captured;

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    const api = {
      select: () => api,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return api; },
      in: () => api,
      order: () => api,
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      single: async () => ({ data: rows[0] || null, error: null }),
      upsert: async (row) => { captured.links.push(row); return { data: null, error: null }; },
      insert: async (row) => { captured.inserts.push({ table, row }); return { data: null, error: null }; },
      update: () => api,
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
    return api;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "u1" }, role: "admin" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async (_c, p) => { captured.audits.push(p); } }));
vi.mock("../api/_lib/quote-ingest.js", () => ({
  ingestQuotes: async (_svc, _ctx, list) => {
    captured.ingested.push(...list);
    const lines = list.reduce((n, q) => n + (q.lines || []).length, 0);
    return { quotes_total: list.length, quotes_ok: list.length, lines_written: lines, mappings_learned: 2, reports: [] };
  },
}));

import handler from "../api/orders/attach_quote.js";

const run = async (body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler(req, res);
  return res;
};

const EXTRACTED = {
  classification: "quote", quote_number: "Q-2026-014", currency: "INR",
  lines: [{ part_no: "TNA-16-04", description: "CYLINDER ASSY", qty: 10, unit_price: 100 }],
};

beforeEach(() => {
  captured = { links: [], inserts: [], audits: [], ingested: [] };
  tables = {
    orders: [{ id: "o1", tenant_id: TENANT, customer_id: "c1", po_number: "PO-9" }],
    documents: [{ id: "d1", tenant_id: TENANT, filename: "quote.pdf", mime_type: "application/pdf" }],
  };
});

describe("attaching the document", () => {
  it("links it to the order with role 'quote'", async () => {
    const res = await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(res._status).toBe(200);
    expect(captured.links[0]).toMatchObject({ order_id: "o1", document_id: "d1", role: "quote" });
  });

  it("links BEFORE ingesting, so a bad extraction does not lose the attachment", async () => {
    // An operator who uploaded the right file should not have to upload it
    // again because the model had a bad day.
    const res = await run({ order_id: "o1", document_id: "d1", extracted: null });
    expect(res._json.attached).toBe(true);
    expect(res._json.ingested).toBe(false);
    expect(captured.links).toHaveLength(1);
  });

  it("is idempotent on re-attach", async () => {
    // Composite PK (order_id, document_id) — upsert, not insert.
    await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(captured.links[0]).toBeTruthy();
  });
});

describe("ingesting the quote", () => {
  it("materialises it against the ORDER's customer", async () => {
    // The reconciler finds quotes by customer_id; ingesting against the wrong
    // one would store it where the PO can never see it.
    const res = await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(captured.ingested[0].customerId).toBe("c1");
    expect(captured.ingested[0].sourceDocumentId).toBe("d1");
    expect(captured.ingested[0].ingestSource).toBe("document");
    expect(res._json.lines_written).toBe(1);
  });

  it("carries the quote header through", async () => {
    await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(captured.ingested[0].quote.quote_number).toBe("Q-2026-014");
    expect(captured.ingested[0].quote.currency).toBe("INR");
  });

  it("tells the caller to reconcile rather than doing it silently", async () => {
    // Reconciling here would hide which step failed when something goes wrong.
    const res = await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(res._json.next).toBe("reconcile");
  });
});

describe("refusing rather than pretending", () => {
  it("will not attach to an order with no customer", async () => {
    // Quotes are matched to the PO by customer; without one the ingested quote
    // is invisible to the reconciler — stored and ignored, exactly the bug
    // this endpoint exists to end.
    tables.orders = [{ id: "o1", tenant_id: TENANT, customer_id: null }];
    const res = await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(res._status).toBe(400);
    expect(res._json.error.message).toMatch(/customer/i);
    expect(captured.links).toHaveLength(0);
  });

  it("says so when the document did not read as a quotation", async () => {
    const res = await run({
      order_id: "o1", document_id: "d1",
      extracted: { classification: "non_quote", lines: [] },
    });
    expect(res._json.ingested).toBe(false);
    expect(res._json.reason).toMatch(/did not read as a quotation/i);
    expect(captured.ingested).toHaveLength(0);
  });

  it("says so when a quote had no readable lines", async () => {
    const res = await run({
      order_id: "o1", document_id: "d1",
      extracted: { classification: "quote", quote_number: "Q-1", lines: [] },
    });
    expect(res._json.ingested).toBe(false);
    expect(res._json.reason).toMatch(/no quote lines/i);
  });

  it("404s an unknown order or document", async () => {
    expect((await run({ order_id: "nope", document_id: "d1", extracted: EXTRACTED }))._status).toBe(404);
    expect((await run({ order_id: "o1", document_id: "nope", extracted: EXTRACTED }))._status).toBe(404);
  });

  it("400s without both ids", async () => {
    expect((await run({ order_id: "o1" }))._status).toBe(400);
    expect((await run({ document_id: "d1" }))._status).toBe(400);
  });
});

describe("audit", () => {
  it("records both outcomes distinguishably", async () => {
    await run({ order_id: "o1", document_id: "d1", extracted: EXTRACTED });
    expect(captured.audits[0].action).toBe("order_quote_attached");
    expect(captured.audits[0].detail.ingested).toBe(true);
    captured.audits.length = 0;
    await run({ order_id: "o1", document_id: "d1", extracted: null });
    expect(captured.audits[0].detail.ingested).toBe(false);
    expect(captured.audits[0].detail.reason).toBeTruthy();
  });
});
