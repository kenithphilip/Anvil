// Migration 161: price_composition_lines.supplier_id (FK to suppliers).
// Verifies the plain POST upsert path persists + returns supplier_id and
// that GET round-trips it. In-memory Supabase fake.

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
      const q = {
        _op: "select", _filters: [], _payload: null, _select: false,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(col, val) { this._filters.push({ col, val }); return this; },
        order() { return this; },
        _match(r) { return this._filters.every((f) => r[f.col] === f.val); },
        _exec(single) {
          const store = rowsRef();
          let data = null;
          if (this._op === "select") { const hit = store.filter((r) => this._match(r)); data = single ? (hit[0] || null) : hit; }
          else if (this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => {
              const ex = store.find((r) => r.tenant_id === it.tenant_id && r.quote_id === it.quote_id && r.line_index === it.line_index);
              if (ex) { Object.assign(ex, it); return ex; }
              const rec = { id: "id-" + (++H.seq), ...it }; store.push(rec); return rec;
            });
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); data = null; }
          return Promise.resolve({ data, error: null });
        },
        single() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        maybeSingle() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/admin/price_composition_lines.js");

const run = async ({ method = "POST", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  const req = { method, headers: {}, url: "/api/admin/price_composition_lines", query, body: body ?? {} };
  await handler(req, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => { H.seq = 0; H.store = { price_composition_lines: [] }; });

describe("price_composition_lines supplier_id (migration 161)", () => {
  it("persists supplier_id on upsert and returns it", async () => {
    const out = await run({ method: "POST", body: { quote_id: "q1", lines: [
      { line_index: 0, part_no: "P-1", supplier_name: "Northwind Korea", supplier_id: "sup-9", supplier_unit_price: 10 },
    ] } });
    expect(out.statusCode).toBe(200);
    expect(out.body.lines[0].supplier_id).toBe("sup-9");
    expect(out.body.lines[0].supplier_name).toBe("Northwind Korea");
  });

  it("defaults supplier_id to null when omitted", async () => {
    const out = await run({ method: "POST", body: { quote_id: "q1", lines: [{ line_index: 0, part_no: "P-2" }] } });
    expect(out.statusCode).toBe(200);
    expect(out.body.lines[0].supplier_id == null).toBe(true);
  });

  it("GET round-trips supplier_id", async () => {
    await run({ method: "POST", body: { quote_id: "q2", lines: [{ line_index: 0, supplier_id: "sup-42" }] } });
    const out = await run({ method: "GET", query: { quote_id: "q2" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.lines[0].supplier_id).toBe("sup-42");
  });
});
