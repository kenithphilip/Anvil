// POST /api/orders/attach_sales_order is tenant-scoped on every read it makes.
//
// The "PO vs ERP" tab now calls it with the order id of the open order. An
// order id or a document id from a request body is not proof the caller may
// use it, so both are checked against the caller's tenant, and the
// buyer-reference match only looks at the caller's own orders. These tests run
// the real handler; only the database is faked. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      // The handler passes the reference with no wildcards, so ilike is a
      // case-insensitive equality here.
      ilike(c, v) { this._f.push((r) => String(r[c] || "").toLowerCase() === String(v).toLowerCase()); return this; },
      upsert(p) { this._op = "upsert"; this._payload = p; return this; },
      _run() {
        if (this._op === "upsert") {
          rows().push({ ...this._payload });
          return { data: null, error: null };
        }
        return { data: rows().filter((r) => this._f.every((fn) => fn(r))), error: null };
      },
      maybeSingle() { const r = this._run(); return Promise.resolve({ data: r.data?.[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve(this._run()).then(res, rej); },
    };
    return q;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { default: handler } = await import("../api/orders/attach_sales_order.js");

const post = async (body) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "POST", headers: {}, body }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const SO = (ref = "PO-TEST-0001") => ({
  classification: "sales_order", voucher_no: "SO-4417", buyer_ref_order_no: ref,
  lines: [{ partNumber: "P-1", quantity: 2 }],
});

beforeEach(() => {
  H.ctx = { user: { id: "u-1" }, tenantId: "t-1", role: "sales_engineer" };
  H.store = {
    documents: [
      { id: "doc-own", tenant_id: "t-1", filename: "erp-so.pdf" },
      { id: "doc-other", tenant_id: "t-2", filename: "theirs.pdf" },
    ],
    orders: [
      { id: "ord-own", tenant_id: "t-1", po_number: "PO-TEST-0001", status: "APPROVED" },
      { id: "ord-other", tenant_id: "t-2", po_number: "PO-TEST-0001", status: "APPROVED" },
      { id: "ord-other-only", tenant_id: "t-2", po_number: "PO-TEST-0002", status: "APPROVED" },
    ],
    order_documents: [],
  };
});

describe("attach_sales_order: tenant scope", () => {
  it("attaches the caller's document to the caller's order", async () => {
    const r = await post({ document_id: "doc-own", extracted: SO(), order_id: "ord-own" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ attached: true, matched_via: "explicit", order: { id: "ord-own" } });
    expect(H.store.order_documents).toEqual([{ order_id: "ord-own", document_id: "doc-own", role: "sales_order" }]);
  });

  it("refuses another tenant's document", async () => {
    const r = await post({ document_id: "doc-other", extracted: SO(), order_id: "ord-own" });
    expect(r.status).toBe(404);
    expect(H.store.order_documents).toEqual([]);
  });

  it("refuses another tenant's order named as the override", async () => {
    const r = await post({ document_id: "doc-own", extracted: SO(), order_id: "ord-other" });
    expect(r.status).toBe(404);
    expect(H.store.order_documents).toEqual([]);
  });

  it("matches the buyer reference against the caller's orders only", async () => {
    // Both tenants hold an order for PO-TEST-0001. Only the caller's counts,
    // so the match is not ambiguous and does not land on the other tenant.
    const r = await post({ document_id: "doc-own", extracted: SO("PO-TEST-0001") });
    expect(r.body).toMatchObject({ attached: true, matched_via: "buyer_reference", order: { id: "ord-own" } });
    expect(H.store.order_documents).toEqual([{ order_id: "ord-own", document_id: "doc-own", role: "sales_order" }]);
  });

  it("does not find a PO that exists only in another tenant", async () => {
    const r = await post({ document_id: "doc-own", extracted: SO("PO-TEST-0002") });
    expect(r.status).toBe(200);
    expect(r.body.attached).toBe(false);
    expect(H.store.order_documents).toEqual([]);
  });

  it("needs write permission", async () => {
    H.ctx = { user: { id: "u-v" }, tenantId: "t-1", role: "viewer" };
    const r = await post({ document_id: "doc-own", extracted: SO(), order_id: "ord-own" });
    expect(r.status).toBe(403);
    expect(H.store.order_documents).toEqual([]);
  });
});
