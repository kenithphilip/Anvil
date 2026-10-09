// GET /api/orders/register: one row per received PO, tenant-scoped,
// server-filtered and server-paginated.
//
// These tests run the real handler against an in-memory PostgREST stand-in
// that applies the select (JSON paths and the customer embed), the filters
// (eq, neq, in, is, not, or with and(), gte, lt), the ordering, the range and
// the exact count. Invented fixtures; no real customer data.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as XLSX from "xlsx";

const H = vi.hoisted(() => ({ ctx: null, store: null, audits: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (_ctx, p) => { H.audits.push(p); }),
  recordEvent: vi.fn(async () => {}),
}));

// ── A small PostgREST stand-in ────────────────────────────────────────────
const getPath = (row, path) => {
  const parts = String(path).split(/(->>|->)/);
  let v = row[parts[0]];
  let textOut = false;
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    const key = parts[i + 1];
    v = v == null || typeof v !== "object" ? undefined : v[key];
    textOut = op === "->>";
  }
  if (v === undefined || v === null) return null;
  if (textOut) return typeof v === "object" ? JSON.stringify(v) : String(v);
  return v;
};

const splitTop = (s) => {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

const condPred = (cond) => {
  const m = cond.match(/^(and|or)\((.*)\)$/);
  if (m) {
    const preds = splitTop(m[2]).map(condPred);
    return m[1] === "and" ? (r) => preds.every((p) => p(r)) : (r) => preds.some((p) => p(r));
  }
  const i = cond.indexOf(".");
  const j = cond.indexOf(".", i + 1);
  const col = cond.slice(0, i);
  const op = cond.slice(i + 1, j);
  const val = cond.slice(j + 1);
  if (op === "eq") return (r) => getPath(r, col) === val;
  if (op === "neq") return (r) => { const v = getPath(r, col); return v !== null && v !== val; };
  if (op === "is" && val === "null") return (r) => getPath(r, col) === null;
  throw new Error("fake: unsupported or-condition " + cond);
};

const EMBED_TABLE = { customer_id: "customers" };

const project = (row, cols) => {
  const out = {};
  for (const item of splitTop(cols)) {
    const embed = item.match(/^(\w+):(\w+)\((.*)\)$/);
    if (embed) {
      const [, alias, fk, fields] = embed;
      const target = (H.store[EMBED_TABLE[fk]] || []).find((t) => t.id === row[fk]);
      out[alias] = target ? Object.fromEntries(fields.split(",").map((f) => [f.trim(), target[f.trim()]])) : null;
      continue;
    }
    const colon = item.indexOf(":");
    if (colon > -1) out[item.slice(0, colon)] = getPath(row, item.slice(colon + 1));
    else out[item] = getPath(row, item);
  }
  return out;
};

const makeSvc = () => ({
  from(table) {
    const q = {
      _preds: [], _orders: [], _range: null, _cols: "*", _count: false, _filters: [],
      select(cols, opts) { this._cols = cols; this._count = opts?.count === "exact"; return this; },
      _add(name, col, pred) { this._filters.push({ name, col }); this._preds.push(pred); return this; },
      eq(c, v) { return this._add("eq", c, (r) => getPath(r, c) === v); },
      neq(c, v) { return this._add("neq", c, (r) => { const x = getPath(r, c); return x !== null && x !== v; }); },
      in(c, arr) { return this._add("in", c, (r) => arr.includes(getPath(r, c))); },
      is(c, v) { return this._add("is", c, (r) => (v === null ? getPath(r, c) === null : getPath(r, c) === v)); },
      not(c, op, v) {
        if (op !== "is" || v !== null) throw new Error("fake: unsupported not");
        return this._add("not", c, (r) => getPath(r, c) !== null);
      },
      or(s) { return this._add("or", s, condPred("or(" + s + ")")); },
      gte(c, v) { return this._add("gte", c, (r) => String(getPath(r, c)) >= v); },
      lt(c, v) { return this._add("lt", c, (r) => String(getPath(r, c)) < v); },
      order(c, o) { this._orders.push({ c, asc: o?.ascending !== false }); return this; },
      range(a, b) { this._range = [a, b]; return this; },
      _run() {
        (H.queries[table] = H.queries[table] || []).push(this._filters);
        let rows = (H.store[table] || []).filter((r) => this._preds.every((p) => p(r)));
        const count = rows.length;
        for (const { c, asc } of [...this._orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const x = String(getPath(a, c) ?? ""); const y = String(getPath(b, c) ?? "");
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
        const data = this._cols === "*" ? rows : rows.map((r) => project(r, this._cols));
        return { data, error: null, count: this._count ? count : null };
      },
      maybeSingle() { const r = this._run(); return Promise.resolve({ data: r.data[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve(this._run()).then(res, rej); },
    };
    return q;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { default: handler } = await import("../api/orders/register.js");

const get = async (query = {}) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "GET", headers: {}, url: "/api/orders/register", query }, res);
  let body = res.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* not JSON */ } }
  return { status: res.statusCode, headers: res.headers, body };
};

// ── Fixtures ──────────────────────────────────────────────────────────────
const C1 = "c1111111-1111-4111-8111-111111111111";
const C2 = "c2222222-2222-4222-8222-222222222222";
const C9 = "c9999999-9999-4999-8999-999999999999";
const RUN1 = "a1111111-1111-4111-8111-111111111111";
const RUN_OTHER = "a9999999-9999-4999-8999-999999999999";

const order = (id, over) => ({
  id, tenant_id: "t-1", status: "DRAFT", po_number: null, po_date: null, customer_id: null,
  preflight_payload: {}, result: {}, ...over,
});

beforeEach(() => {
  H.ctx = { user: { id: "u-1" }, tenantId: "t-1", role: "sales_engineer" };
  H.audits = [];
  H.queries = {};
  H.store = {
    customers: [
      { id: C1, tenant_id: "t-1", customer_name: "Acme Test Works" },
      { id: C2, tenant_id: "t-1", customer_name: "Beta Test Motors" },
      { id: C9, tenant_id: "t-2", customer_name: "Other Tenant Co" },
    ],
    orders: [
      order("o1", {
        created_at: "2026-10-01T05:00:00.000Z", status: "APPROVED", customer_id: C1,
        po_number: "PO-T-001", po_date: "2026-09-30",
        preflight_payload: { extraction_run_id: RUN1, confidence_overall: 0.8, text: "raw PO text" },
        result: {
          salesOrder: { grandTotal: 1000, currency: "INR", lineItems: [{ partNumber: "P-1" }, { partNumber: "P-2" }] },
          quoteReconciliation: {
            summary: { matched: 1, total: 2 },
            flags: [{ verdict: "price_mismatch", line_no: 1 }, { verdict: "payment_terms_mismatch", line_no: null }],
          },
        },
      }),
      order("o7", { created_at: "2026-10-02T05:00:00.000Z", preflight_payload: { source: "inbound_chat", channel: "slack" } }),
      order("o2", {
        created_at: "2026-10-03T05:00:00.000Z", customer_id: C2, po_number: "PO-T-002",
        // A run id from another tenant: never read across tenants.
        preflight_payload: { source: "email_inbound", extraction_run_id: RUN_OTHER },
      }),
      order("o3", {
        created_at: "2026-10-05T05:00:00.000Z", status: "PENDING_REVIEW", customer_id: C1,
        preflight_payload: { source: "inbound_chat", channel: "whatsapp" },
        result: { salesOrder: { lineItems: [{}, {}, {}] }, quoteReconciliation: { summary: { matched: 3, total: 3 }, flags: [] } },
      }),
      order("o4", { created_at: "2026-10-07T05:00:00.000Z", preflight_payload: { source: "whatsapp_inbound" } }),
      order("o5", { created_at: "2026-10-08T05:00:00.000Z", result: { source_reorder_of: "o1" } }),
      order("o6", { created_at: "2026-10-09T05:00:00.000Z", preflight_payload: { source: "voice_call_action" } }),
      // Another tenant: same PO number, flags, an attached ERP SO.
      order("x1", {
        tenant_id: "t-2", created_at: "2026-10-04T05:00:00.000Z", customer_id: C9, po_number: "PO-T-001",
        result: { quoteReconciliation: { summary: { matched: 0, total: 1 }, flags: [{ verdict: "unmatched", line_no: 1 }] } },
      }),
    ],
    extraction_runs: [
      { id: RUN1, tenant_id: "t-1", status: "ok", confidence_overall: 0.92 },
      { id: RUN_OTHER, tenant_id: "t-2", status: "ok", confidence_overall: 0.99 },
      { id: "r-so-1", tenant_id: "t-1", extraction_kind: "sales_order", source_id: "doc-so-1", normalized_extract: { voucher_no: "SO-77" }, finished_at: "2026-10-02T00:00:00Z", status_reason: "ok" },
      { id: "r-so-x", tenant_id: "t-2", extraction_kind: "sales_order", source_id: "doc-so-x", normalized_extract: { voucher_no: "SO-OTHER" }, finished_at: "2026-10-05T00:00:00Z", status_reason: "ok" },
    ],
    order_documents: [
      { order_id: "o1", document_id: "doc-so-1", role: "sales_order" },
      { order_id: "x1", document_id: "doc-so-x", role: "sales_order" },
      { order_id: "o3", document_id: "doc-po-3", role: "purchase_order" },
    ],
  };
});

const ids = (r) => r.body.rows.map((x) => x.id);

describe("register: tenant scope", () => {
  it("returns only the caller's orders, newest first, with a true total", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(["o6", "o5", "o4", "o3", "o2", "o7", "o1"]);
    expect(r.body.total).toBe(7);
    expect(ids(r)).not.toContain("x1");
  });

  it("does not read another tenant's extraction run, even when an order names it", async () => {
    const r = await get();
    const o2 = r.body.rows.find((x) => x.id === "o2");
    expect(o2.extraction.status).toBe("not_extracted");
    expect(o2.extraction.confidence).toBeNull();
    for (const filters of H.queries.extraction_runs) {
      expect(filters).toContainEqual({ name: "eq", col: "tenant_id" });
    }
  });

  it("is gated like the orders list: any reader, and nobody else", async () => {
    H.ctx = { user: { id: "u-v" }, tenantId: "t-1", role: "viewer" };
    expect((await get()).status).toBe(200);
    H.ctx = { user: { id: "u-x" }, tenantId: "t-1", role: "customer" };
    expect((await get()).status).toBe(403);
  });
});

describe("register: the row", () => {
  it("carries channel, customer, PO, value, lines, extraction, reconciliation, status, ERP SO and handoff", async () => {
    const r = await get();
    const o1 = r.body.rows.find((x) => x.id === "o1");
    expect(o1).toEqual({
      id: "o1",
      received_at: "2026-10-01T05:00:00.000Z",
      channel: "upload",
      customer_id: C1,
      customer_name: "Acme Test Works",
      po_number: "PO-T-001",
      po_date: "2026-09-30",
      value: 1000,
      currency: "INR",
      line_count: 2,
      extraction: { status: "ok", confidence: 0.92, run_id: RUN1 },
      reconciliation: { analysed: true, as_of: null, matched: 1, total: 2, line_flags: 1, terms_flags: 1 },
      status: "APPROVED",
      erp_so: { attached: true, voucher_no: "SO-77" },
      handoff: { status: "not_sent" },
    });
  });

  it("derives the channel from how the order arrived", async () => {
    const r = await get();
    const ch = Object.fromEntries(r.body.rows.map((x) => [x.id, x.channel]));
    expect(ch).toEqual({ o1: "upload", o7: "chat", o2: "email", o3: "whatsapp", o4: "whatsapp", o5: "portal", o6: "voice" });
  });

  it("says when an order was never reconciled, and has no ERP SO", async () => {
    const r = await get();
    const o2 = r.body.rows.find((x) => x.id === "o2");
    expect(o2.reconciliation).toEqual({ analysed: false });
    expect(o2.erp_so).toEqual({ attached: false, voucher_no: null });
    // A purchase-order document is not an ERP sales order.
    expect(r.body.rows.find((x) => x.id === "o3").erp_so.attached).toBe(false);
  });

  it("never returns the raw PO text", async () => {
    const r = await get();
    expect(JSON.stringify(r.body)).not.toContain("raw PO text");
  });
});

describe("register: filters", () => {
  it("filters by received date range (to includes its day)", async () => {
    expect(ids(await get({ from: "2026-10-03", to: "2026-10-05" }))).toEqual(["o3", "o2"]);
  });

  it("filters by customer", async () => {
    expect(ids(await get({ customer: C1 }))).toEqual(["o3", "o1"]);
  });

  it.each([
    ["upload", ["o1"]],
    ["email", ["o2"]],
    ["whatsapp", ["o4", "o3"]],
    ["chat", ["o7"]],
    ["voice", ["o6"]],
    ["portal", ["o5"]],
  ])("filters by channel %s", async (channel, expected) => {
    expect(ids(await get({ channel }))).toEqual(expected);
  });

  it("filters by status", async () => {
    expect(ids(await get({ status: "PENDING_REVIEW" }))).toEqual(["o3"]);
  });

  it("has_flags keeps only orders whose reconciliation recorded a flag", async () => {
    // o3 was reconciled with no flags; the others were never reconciled.
    expect(ids(await get({ has_flags: "1" }))).toEqual(["o1"]);
  });

  it("combines filters", async () => {
    expect(ids(await get({ customer: C1, channel: "whatsapp" }))).toEqual(["o3"]);
  });

  it.each([
    [{ channel: "fax" }, /channel must be one of/],
    [{ status: "SHIPPED" }, /status must be one of/],
    [{ customer: "not-an-id" }, /customer must be a customer id/],
    [{ from: "yesterday" }, /from is not a valid date/],
  ])("rejects a bad filter %j with 400", async (query, msg) => {
    const r = await get(query);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(msg);
  });
});

describe("register: pagination", () => {
  it("pages on the server and reports the total and whether there is more", async () => {
    const p1 = await get({ page_size: "3" });
    expect(ids(p1)).toEqual(["o6", "o5", "o4"]);
    expect(p1.body).toMatchObject({ page: 1, page_size: 3, total: 7, has_more: true });

    const p3 = await get({ page_size: "3", page: "3" });
    expect(ids(p3)).toEqual(["o1"]);
    expect(p3.body).toMatchObject({ page: 3, total: 7, has_more: false });
  });

  it("counts the filtered set, not the tenant", async () => {
    const r = await get({ channel: "whatsapp", page_size: "1" });
    expect(ids(r)).toEqual(["o4"]);
    expect(r.body).toMatchObject({ total: 2, has_more: true });
  });

  it("caps the page size", async () => {
    expect((await get({ page_size: "5000" })).body.page_size).toBe(200);
  });
});

describe("register: Excel export", () => {
  it("exports the filtered register as a workbook, and audits it", async () => {
    const r = await get({ format: "xlsx", customer: C1 });
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toMatch(/spreadsheetml/);
    expect(r.headers["Content-Disposition"]).toMatch(/SO_register_\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = XLSX.read(r.body, { type: "buffer" });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    expect(aoa[0][0]).toBe("Received");
    expect(aoa.slice(1).map((row) => row[3])).toEqual(["", "PO-T-001"]);
    expect(aoa[2]).toContain("SO-77");
    expect(aoa[2]).toContain("not sent");
    expect(JSON.stringify(aoa)).not.toContain("Other Tenant Co");
    expect(H.audits).toEqual([expect.objectContaining({ action: "so_register_exported", detail: "rows=2" })]);
  });
});
