// PR5: spare_matrix/<id>/to_quote — feed the Recommended Spares sheet into
// a DRAFT quote. Verifies it writes BOTH line_items JSONB AND quote_lines
// rows, only feeds recommended_qty>0, links rows back, and is re-run safe.
// In-memory Supabase fake (extends the recommended test's fake with
// count/head/like/limit so generateQuoteNumber + the reuse guard work).

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rowsRef = () => H.store[table];
      const likeToRe = (pat) => new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
      const q = {
        _op: "select", _filters: [], _payload: null, _select: false, _count: false, _head: false, _limit: null,
        select(_cols, opts) { this._select = true; if (opts && opts.count) this._count = true; if (opts && opts.head) this._head = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(col, val) { this._filters.push({ t: "eq", col, val }); return this; },
        in(col, arr) { this._filters.push({ t: "in", col, arr }); return this; },
        like(col, pat) { this._filters.push({ t: "like", col, re: likeToRe(pat) }); return this; },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        _match(r) {
          return this._filters.every((f) =>
            f.t === "eq" ? r[f.col] === f.val
            : f.t === "in" ? f.arr.includes(r[f.col])
            : f.t === "like" ? f.re.test(String(r[f.col] == null ? "" : r[f.col]))
            : true);
        },
        _exec(single) {
          const store = rowsRef();
          let data = null; let count = null;
          if (this._op === "select") {
            let hit = store.filter((r) => this._match(r));
            count = hit.length;
            if (this._limit != null) hit = hit.slice(0, this._limit);
            if (this._head) return Promise.resolve({ data: null, count, error: null });
            data = single ? (hit[0] || null) : hit;
          } else if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => {
              if (this._op === "upsert" && it.id) { const ex = store.find((r) => r.id === it.id); if (ex) { Object.assign(ex, it); return ex; } }
              const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); return rec;
            });
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "update") {
            const hit = store.filter((r) => this._match(r)); hit.forEach((r) => Object.assign(r, this._payload));
            data = this._select ? (single ? (hit[0] || null) : hit) : null;
          } else if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); data = null; }
          return Promise.resolve({ data, count, error: null });
        },
        single() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        maybeSingle() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { default: toQuote } = await import("../api/spare_matrix/to_quote.js");

const run = async (handler, { method = "POST", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  const req = { method, headers: {}, url: "/api/spare_matrix", query, body: body || {} };
  await handler(req, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    spare_matrix: [
      { id: "m1", tenant_id: "t-1", customer_id: "cust-1", project_name: "Pune", name: "Hyundai Pune Servo" },
      { id: "m-nocust", tenant_id: "t-1", customer_id: null, project_name: "X", name: "No customer" },
      { id: "m-empty", tenant_id: "t-1", customer_id: "cust-1", project_name: "Y", name: "Nothing to feed" },
    ],
    customers: [{ id: "cust-1", tenant_id: "t-1", currency: "INR", default_quote_validity_days: 45 }],
    quotes: [],
    quote_lines: [],
    recommended_spares: [
      { id: "e1", tenant_id: "t-1", matrix_id: "m1", sr_no: 1, description: "CAP TIP", part_no: "4-TP2109-1", installed_qty: 2, recommended_qty: 500, item_type: "Consumable", customer_part_no: "CUST-CT-1" },
      { id: "e2", tenant_id: "t-1", matrix_id: "m1", sr_no: 2, description: "SHUNT", part_no: "SHN-1", installed_qty: 2, recommended_qty: 0, item_type: "Consumable" },
      { id: "e3", tenant_id: "t-1", matrix_id: "m1", sr_no: 3, description: "CAP TIP", part_no: "CT-16-D", installed_qty: 1, recommended_qty: 10, item_type: "Consumable" },
      { id: "z1", tenant_id: "t-1", matrix_id: "m-nocust", sr_no: 1, description: "CAP TIP", part_no: "P1", recommended_qty: 5 },
      { id: "y1", tenant_id: "t-1", matrix_id: "m-empty", sr_no: 1, description: "CAP TIP", part_no: "P2", recommended_qty: 0 },
    ],
  };
});

describe("spare_matrix to_quote (PR5)", () => {
  it("creates a DRAFT quote from recommended_qty>0 rows, writing BOTH line_items and quote_lines", async () => {
    const out = await run(toQuote, { query: { id: "m1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.fed).toBe(2);                 // e1 + e3 (e2 has qty 0)
    expect(out.body.reused).toBeFalsy();

    const quote = out.body.quote;
    expect(quote.status).toBe("DRAFT");
    expect(quote.currency).toBe("INR");
    expect(quote.validity_days).toBe(45);         // from customer default
    expect(quote.source_matrix_id).toBe("m1");
    expect(quote.customer_id).toBe("cust-1");
    expect(quote.quote_number).toMatch(/^Q-\d{6}-0001$/);
    expect(quote.grand_total).toBe(0);            // unpriced

    // line_items JSONB (render path)
    const li = quote.line_items;
    expect(Array.isArray(li)).toBe(true);
    expect(li.length).toBe(2);
    const byPart = Object.fromEntries(li.map((l) => [l.partNumber, l]));
    expect(byPart["4-TP2109-1"].quantity).toBe(500);
    expect(byPart["4-TP2109-1"].unitPrice).toBe(0);
    expect(byPart["CT-16-D"].quantity).toBe(10);

    // quote_lines rows (convert.js path) — same 2, unpriced, indexed 0..1
    const lines = H.store.quote_lines.filter((r) => r.quote_id === quote.id).sort((a, b) => a.line_index - b.line_index);
    expect(lines.length).toBe(2);
    expect(lines[0].line_index).toBe(0);
    expect(lines[0].part_no).toBe("4-TP2109-1");
    expect(lines[0].qty).toBe(500);
    expect(lines[0].listed_unit_price).toBe(0);
    expect(lines[0].customer_part_number).toBe("CUST-CT-1");
    expect(lines[1].part_no).toBe("CT-16-D");

    // fed recommended rows linked back to the quote; the qty-0 row is not.
    const rec = Object.fromEntries(H.store.recommended_spares.map((r) => [r.id, r]));
    expect(rec.e1.quote_id).toBe(quote.id);
    expect(rec.e1.quote_ref).toBe(quote.quote_number);
    expect(rec.e3.quote_id).toBe(quote.id);
    expect(rec.e2.quote_id == null).toBe(true);
  });

  it("re-run reuses the existing DRAFT instead of duplicating", async () => {
    const first = await run(toQuote, { query: { id: "m1" } });
    const firstId = first.body.quote.id;
    const second = await run(toQuote, { query: { id: "m1" } });
    expect(second.statusCode).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.quote.id).toBe(firstId);
    // still exactly one quote for this matrix
    expect(H.store.quotes.filter((q) => q.source_matrix_id === "m1").length).toBe(1);
  });

  it("force=true creates a second quote even when a draft exists", async () => {
    await run(toQuote, { query: { id: "m1" } });
    const forced = await run(toQuote, { query: { id: "m1" }, body: { force: true } });
    expect(forced.statusCode).toBe(200);
    expect(forced.body.reused).toBeFalsy();
    expect(H.store.quotes.filter((q) => q.source_matrix_id === "m1").length).toBe(2);
  });

  it("400 when the matrix has no customer", async () => {
    const out = await run(toQuote, { query: { id: "m-nocust" } });
    expect(out.statusCode).toBe(400);
    expect(String(out.body.error.message)).toMatch(/customer/i);
  });

  it("400 when no rows have a recommended qty", async () => {
    const out = await run(toQuote, { query: { id: "m-empty" } });
    expect(out.statusCode).toBe(400);
    expect(String(out.body.error.message)).toMatch(/recommended quantity/i);
  });

  it("404 for an unknown matrix", async () => {
    const out = await run(toQuote, { query: { id: "nope" } });
    expect(out.statusCode).toBe(404);
  });

  it("selective feed: row_ids feeds only the checked rows", async () => {
    const out = await run(toQuote, { query: { id: "m1" }, body: { row_ids: ["e1"], group: "consumables" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.fed).toBe(1);
    expect(out.body.quote.line_items.length).toBe(1);
    expect(out.body.quote.line_items[0].partNumber).toBe("4-TP2109-1");
  });

  it("spares and consumables go on SEPARATE grouped drafts", async () => {
    H.store.recommended_spares.push({ id: "sp1", tenant_id: "t-1", matrix_id: "m1", sr_no: 9, description: "GEAR CASE ASSY", part_no: "X168-STD", installed_qty: 2, recommended_qty: 2, item_type: "Spare" });
    const cons = await run(toQuote, { query: { id: "m1" }, body: { row_ids: ["e1", "e3"], group: "consumables" } });
    const spares = await run(toQuote, { query: { id: "m1" }, body: { row_ids: ["sp1"], group: "spares" } });
    expect(cons.body.quote.id).not.toBe(spares.body.quote.id);            // two distinct drafts
    expect(H.store.quotes.filter((q) => q.source_matrix_id === "m1").length).toBe(2);
    expect(cons.body.quote.line_items.length).toBe(2);
    expect(spares.body.quote.line_items.length).toBe(1);
    expect(spares.body.quote.line_items[0].partNumber).toBe("X168-STD");
    // re-feeding the consumables group re-syncs ITS draft, not the spares one.
    const cons2 = await run(toQuote, { query: { id: "m1" }, body: { row_ids: ["e1"], group: "consumables" } });
    expect(cons2.body.quote.id).toBe(cons.body.quote.id);
    expect(cons2.body.quote.line_items.length).toBe(1);
    expect(H.store.quotes.filter((q) => q.source_matrix_id === "m1").length).toBe(2); // still 2
  });

  it("re-feed RE-SYNCS the existing draft to the current selection (bug: others not pushed)", async () => {
    const first = await run(toQuote, { query: { id: "m1" } });
    expect(first.body.fed).toBe(2); // e1 + e3 (e2 qty 0)
    const qid = first.body.quote.id;
    expect(H.store.quote_lines.filter((l) => l.quote_id === qid).length).toBe(2);

    // Operator now fills another part's recommended qty and feeds again.
    H.store.recommended_spares.find((r) => r.id === "e2").recommended_qty = 5;
    const second = await run(toQuote, { query: { id: "m1" } });
    expect(second.statusCode).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.quote.id).toBe(qid);         // same draft, not a duplicate
    expect(second.body.fed).toBe(3);                // now 3 rows fed
    expect(H.store.quote_lines.filter((l) => l.quote_id === qid).length).toBe(3); // re-synced, not stale
    expect(H.store.quotes.filter((q) => q.source_matrix_id === "m1").length).toBe(1);
  });
});
