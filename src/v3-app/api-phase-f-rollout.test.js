// Phase F integration tests.
//
//   F.2 - source_pos/ack_extract -> ack_accept end-to-end.
//   F.4 + F.6 - invoices/extract materialises ap_invoices +
//   ap_invoice_lines so /api/ap/match can run.
//
// Both tests stub Anthropic + Mistral via the same mocks as the
// pipeline integration test, then drive the real endpoint
// handlers with a synthetic ctx + svc shim so we can assert
// what the endpoints actually persist.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- shared mocks -----------------------------------------------

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = 500; res._json = { error: { message: err?.message || String(err) } }; },
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async (req) => req._ctx || { tenantId: "t1", userId: "u1" },
  requirePermission: () => undefined,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: async () => ({ docai_provider_order: ["claude"] }),
}));

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async ({ bytes }) => ({
    ok: true, status: "has_text",
    page_count: 1, char_count: 500,
    body_text: bytes ? bytes.toString("utf8").slice(0, 500) : "stub",
    page_breakdown: [{ page: 1, chars: 500, has_text: true }],
    extractor: "unpdf", extractor_version: "test", latency_ms: 5, error: null,
  })),
  contentHash: vi.fn(async () => "stub-hash"),
  looksLikePdf: () => true,
  TEXT_LAYER_THRESHOLDS: { usable: 200, perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async () => ({
    ok: false, status: "failed",
    page_count: 0, char_count: 0, body_text: null, page_breakdown: [],
    bbox_count: 0, provider: "mistral", provider_model: null, latency_ms: 1,
    raw_pages: [], error: "stub",
  })),
  OCR_LAYER_THRESHOLDS: { perPage: 30, bodyTextBytes: 200_000 },
}));

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async ({ hints }) => {
    if (hints?.expectedKind === "supplier_ack") {
      return {
        ok: true,
        adapter_used: "claude",
        confidence_overall: 0.92,
        confidences: { overall: 0.92 },
        normalized: {
          classification: "ack",
          customer: null,
          lines: [
            { partNumber: "BRG-6204", quantity: 100, unitPrice: 130, eta: "2026-06-30", rejected: false },
          ],
          supplier_ack: {
            supplier_ref: "SUP-12345",
            confirmed_price: 13_000,
            confirmed_currency: "INR",
            confirmed_eta: "2026-06-30",
            payment_terms: "Net 30",
            remarks: "Awaiting freight confirmation",
          },
        },
        raw: {},
        attempts: [{ adapter: "claude", status: "ok" }],
        mode: "pre_extracted_text",
      };
    }
    if (hints?.expectedKind === "invoice") {
      return {
        ok: true,
        adapter_used: "claude",
        confidence_overall: 0.94,
        confidences: { overall: 0.94 },
        normalized: {
          classification: "po",
          customer: { name: "Vendor Co", po_number: "INV-9001", currency: "INR" },
          lines: [
            { partNumber: "BRG-6204", description: "Bearing", quantity: 100, unitPrice: 125, hsn: "8482", gst_pct: 18 },
            { partNumber: "BRG-6205", description: "Bearing 5", quantity: 50, unitPrice: 145, hsn: "8482", gst_pct: 18 },
          ],
        },
        raw: {},
        attempts: [{ adapter: "claude", status: "ok" }],
        mode: "pre_extracted_text",
      };
    }
    return {
      ok: true,
      adapter_used: "claude",
      confidence_overall: 0.9,
      confidences: { overall: 0.9 },
      normalized: { classification: "po", customer: { name: "Acme" }, lines: [] },
      raw: {},
      attempts: [{ adapter: "claude", status: "ok" }],
      mode: "pre_extracted_text",
    };
  }),
  buildPromptOverrides: () => null,
}));

vi.mock("../api/_lib/supabase.js", () => {
  let svc = null;
  return {
    serviceClient: () => svc,
    __setSvc: (s) => { svc = s; },
  };
});

// --- shim builder ----------------------------------------------

let runCounter = 1;
const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];
  const newCtx = (table) => ({ table, filters: [], action: null, values: null });
  const builder = (table) => {
    const ctx = newCtx(table);
    const matchesFilters = (r) => ctx.filters.every((f) => (
      f.op === "eq" ? r[f.col] === f.v
      : f.op === "in" ? Array.isArray(f.v) && f.v.includes(r[f.col])
      : f.op === "is" ? r[f.col] === f.v
      : true
    ));
    const api = {
      select(_c) { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      in(c, v) { ctx.filters.push({ col: c, op: "in", v }); return api; },
      is(c, v) { ctx.filters.push({ col: c, op: "is", v }); return api; },
      order(c) { ctx.order = c; return api; },
      limit(n) { ctx.limit = n; return api; },
      maybeSingle() {
        // Apply pending update if this is the terminator on an
        // update chain (supabase-js: update().eq().select().maybeSingle()).
        if (ctx.action === "update") {
          const rows = get(table);
          const updated = rows.map((r) => (matchesFilters(r) ? { ...r, ...ctx.values } : r));
          tables.set(table, updated);
          return Promise.resolve({ data: updated.filter(matchesFilters)[0] || null, error: null });
        }
        return Promise.resolve({ data: get(table).filter(matchesFilters)[0] || null, error: null });
      },
      single() {
        if (ctx.action === "update") {
          const rows = get(table);
          const updated = rows.map((r) => (matchesFilters(r) ? { ...r, ...ctx.values } : r));
          tables.set(table, updated);
          const filtered = updated.filter(matchesFilters);
          if (!filtered.length) return Promise.resolve({ data: null, error: { message: "no row" } });
          return Promise.resolve({ data: filtered[0], error: null });
        }
        const rows = get(table).filter(matchesFilters);
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "no row" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve) {
        if (ctx.action === "update") {
          const rows = get(table);
          const updated = rows.map((r) => (matchesFilters(r) ? { ...r, ...ctx.values } : r));
          tables.set(table, updated);
          resolve({ data: updated.filter(matchesFilters), error: null });
        } else if (ctx.action === "delete") {
          tables.set(table, get(table).filter((r) => !matchesFilters(r)));
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
        const id = table === "extraction_runs" ? "run-" + (runCounter++)
                  : table === "ap_invoices" ? "ap-" + (runCounter++)
                  : "id-" + Math.random().toString(36).slice(2);
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

beforeEach(() => { vi.clearAllMocks(); runCounter = 1; });

// --- Phase F.2 end-to-end --------------------------------------

describe("Phase F.2 / source_pos ack_extract -> ack_accept", () => {
  it("extracts a supplier ack PDF and persists a review row", async () => {
    const supplierPoId = "sp-1";
    const svc = buildSvc({
      source_pos: [{
        id: supplierPoId,
        tenant_id: "t1",
        status: "OPEN",
        supplier: "Vendor Co",
        total_foreign: 12_500,
        currency: "INR",
        payload: {},
      }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);

    const handler = (await import("../api/source_pos/ack_extract.js")).default;
    const req = {
      method: "POST",
      url: "/api/source_pos/" + supplierPoId + "/ack_extract",
      query: { id: supplierPoId },
      _body: { bytes_base64: Buffer.from("ack pdf bytes ".repeat(20)).toString("base64") },
      _ctx: { tenantId: "t1", userId: "u1" },
      headers: {},
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.status).toBe("ok");
    expect(res._json.supplier_ack_extraction).toBeTruthy();
    const ackRows = svc._tables.get("supplier_ack_extractions");
    expect(ackRows).toHaveLength(1);
    expect(ackRows[0].confirmed_price).toBe(13_000);
    expect(ackRows[0].confirmed_eta).toBe("2026-06-30");
    expect(ackRows[0].line_acks).toHaveLength(1);
    expect(ackRows[0].status).toBe("extracted");
  });

  it("commits a reviewed extraction into source_pos via ack_accept", async () => {
    const supplierPoId = "sp-2";
    const svc = buildSvc({
      source_pos: [{
        id: supplierPoId,
        tenant_id: "t1",
        status: "OPEN",
        supplier: "Vendor Co",
        total_foreign: 12_500,
        currency: "INR",
        payload: {},
      }],
      supplier_ack_extractions: [{
        id: "ack-1",
        tenant_id: "t1",
        source_po_id: supplierPoId,
        extraction_run_id: "run-9",
        document_id: null,
        supplier_ref: "SUP-12345",
        confirmed_price: 13_000,
        confirmed_currency: "INR",
        confirmed_eta: "2026-06-30",
        payment_terms: "Net 30",
        remarks: null,
        line_acks: [],
        status: "extracted",
      }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);

    const handler = (await import("../api/source_pos/ack_accept.js")).default;
    const req = {
      method: "POST",
      url: "/api/source_pos/" + supplierPoId + "/ack_accept",
      query: { id: supplierPoId },
      _body: { supplier_ack_extraction_id: "ack-1" },
      _ctx: { tenantId: "t1", userId: "u1" },
      headers: {},
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.source_po).toBeTruthy();
    // Acknowledged price should be 13000 + status flipped to PRICE_CHANGED
    // because 13000 vs expected 12500 = 4% variance > 1%.
    expect(res._json.source_po.acknowledged_price).toBe(13_000);
    expect(res._json.status).toBe("PRICE_CHANGED");
    // The review row is now 'accepted' + has forwarded_at set.
    const accepted = svc._tables.get("supplier_ack_extractions")[0];
    expect(accepted.status).toBe("accepted");
    expect(accepted.forwarded_at).toBeTruthy();
    expect(accepted.ack_payload).toBeTruthy();
  });
});

// --- Phase F.4 + F.6 end-to-end --------------------------------

describe("Phase F.4 + F.6 / invoices/extract materialises AP rows", () => {
  it("creates an ap_invoices row + ap_invoice_lines from the extraction", async () => {
    const svc = buildSvc({});
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);

    const handler = (await import("../api/invoices/extract.js")).default;
    const req = {
      method: "POST",
      url: "/api/invoices/extract",
      query: {},
      _body: {
        bytes_base64: Buffer.from("invoice pdf bytes ".repeat(20)).toString("base64"),
        create_ap_invoice: true,
        vendor_invoice_number: "INV-9001",
        source_po_id: "sp-99",
      },
      _ctx: { tenantId: "t1", userId: "u1" },
      headers: {},
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.status).toBe("ok");
    expect(res._json.ap_invoice_id).toBeTruthy();
    expect(res._json.ap_lines_materialised).toBe(2);
    // ap_invoices row carries totals derived from the extraction.
    const apInvoices = svc._tables.get("ap_invoices") || [];
    expect(apInvoices).toHaveLength(1);
    expect(apInvoices[0].vendor_invoice_number).toBe("INV-9001");
    expect(Number(apInvoices[0].subtotal)).toBeCloseTo(100 * 125 + 50 * 145, 2);
    expect(Number(apInvoices[0].tax_total)).toBeCloseTo((100 * 125 + 50 * 145) * 0.18, 2);
    // ap_invoice_lines carries the canonical shape.
    const apLines = svc._tables.get("ap_invoice_lines") || [];
    expect(apLines).toHaveLength(2);
    expect(apLines[0]).toMatchObject({
      ap_invoice_id: apInvoices[0].id,
      line_no: 1,
      description: "Bearing",
      quantity: 100,
      unit_price: 125,
      po_line_ref: "BRG-6204",
    });
    expect(apLines[0].extended).toBeCloseTo(12_500, 2);
  });

  it("appends lines to an existing ap_invoice when ap_invoice_id is supplied", async () => {
    const svc = buildSvc({
      ap_invoices: [{
        id: "ap-existing-1",
        tenant_id: "t1",
        vendor_invoice_number: "INV-EXISTING",
        currency: "INR",
        subtotal: 0,
        tax_total: 0,
        grand_total: 0,
        match_status: "pending",
      }],
      ap_invoice_lines: [{
        id: "stale-1",
        tenant_id: "t1",
        ap_invoice_id: "ap-existing-1",
        line_no: 99,
        description: "stale line",
        quantity: 1,
        unit_price: 1,
        extended: 1,
      }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);

    const handler = (await import("../api/invoices/extract.js")).default;
    const req = {
      method: "POST",
      url: "/api/invoices/extract",
      query: {},
      _body: {
        bytes_base64: Buffer.from("invoice pdf ".repeat(20)).toString("base64"),
        ap_invoice_id: "ap-existing-1",
      },
      _ctx: { tenantId: "t1", userId: "u1" },
      headers: {},
    };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.ap_invoice_id).toBe("ap-existing-1");
    expect(res._json.ap_lines_materialised).toBe(2);
    // The stale line should have been removed before the fresh insert.
    const remaining = (svc._tables.get("ap_invoice_lines") || []);
    expect(remaining.every((l) => l.line_no !== 99)).toBe(true);
    expect(remaining).toHaveLength(2);
  });
});
