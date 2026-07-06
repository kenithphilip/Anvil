// PR4: recompute_recommended (installed_qty = COUNT of guns per part;
// human edits preserved) + recommended PATCH. In-memory Supabase fake.

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
        update(p) { this._op = "update"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(col, val) { this._filters.push({ t: "eq", col, val }); return this; },
        in(col, arr) { this._filters.push({ t: "in", col, arr }); return this; },
        order() { return this; },
        _match(r) { return this._filters.every((f) => (f.t === "eq" ? r[f.col] === f.val : f.arr.includes(r[f.col]))); },
        _exec(single) {
          const store = rowsRef();
          let data = null;
          if (this._op === "select") { const hit = store.filter((r) => this._match(r)); data = single ? (hit[0] || null) : hit; }
          else if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => {
              if (this._op === "upsert" && it.id) { const ex = store.find((r) => r.id === it.id); if (ex) { Object.assign(ex, it); return ex; } }
              const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); return rec;
            });
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "update") { const hit = store.filter((r) => this._match(r)); hit.forEach((r) => Object.assign(r, this._payload)); data = this._select ? (single ? (hit[0] || null) : hit) : null; }
          else if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); data = null; }
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

const { default: recompute } = await import("../api/spare_matrix/recompute_recommended.js");
const { default: patchRec } = await import("../api/spare_matrix/recommended.js");

const run = async (handler, { method = "POST", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  const req = { method, headers: {}, url: "/api/spare_matrix", query };
  if (body !== undefined) req.body = body;
  await handler(req, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    spare_matrix: [{ id: "m1", tenant_id: "t-1" }],
    spare_matrix_columns: [
      { id: "c1", tenant_id: "t-1", matrix_id: "m1", col_name: "CAP TIP", category: "Consumable" },
      { id: "c2", tenant_id: "t-1", matrix_id: "m1", col_name: "SHUNT", category: "Consumable" },
    ],
    spare_matrix_rows: [
      { id: "r1", tenant_id: "t-1", matrix_id: "m1", position: 0, gun_no: "G1", spare_values: { "CAP TIP": "4-TP2109-1", "SHUNT": "SHN-1" } },
      { id: "r2", tenant_id: "t-1", matrix_id: "m1", position: 1, gun_no: "G2", spare_values: { "CAP TIP": "4-TP2109-1" } },
      { id: "r3", tenant_id: "t-1", matrix_id: "m1", position: 2, gun_no: "G3", spare_values: { "CAP TIP": "CT-16-D", "SHUNT": "SHN-1" } },
    ],
    // A pre-existing human edit that recompute MUST preserve.
    recommended_spares: [{ id: "e1", tenant_id: "t-1", matrix_id: "m1", part_no: "4-TP2109-1", description: "CAP TIP", recommended_qty: 500, priority: "High", installed_qty: 0 }],
  };
});

describe("recompute_recommended (PR4)", () => {
  it("installed_qty = COUNT of guns per (category, part); preserves human edits; seeds item_type", async () => {
    const out = await run(recompute, { method: "POST", query: { id: "m1" } });
    expect(out.statusCode).toBe(200);
    const byKey = Object.fromEntries((out.body.recommended || []).map((r) => [r.description + "|" + r.part_no, r]));

    // 4-TP2109-1 in CAP TIP appears in G1 + G2 -> installed 2; human 500/High preserved.
    expect(byKey["CAP TIP|4-TP2109-1"].installed_qty).toBe(2);
    expect(byKey["CAP TIP|4-TP2109-1"].recommended_qty).toBe(500);
    expect(byKey["CAP TIP|4-TP2109-1"].priority).toBe("High");
    // CT-16-D in CAP TIP only G3 -> installed 1; item_type seeded Consumable.
    expect(byKey["CAP TIP|CT-16-D"].installed_qty).toBe(1);
    expect(byKey["CAP TIP|CT-16-D"].item_type).toBe("Consumable");
    // SHN-1 in SHUNT appears in G1 + G3 -> installed 2.
    expect(byKey["SHUNT|SHN-1"].installed_qty).toBe(2);
    // representative gun is set.
    expect(byKey["SHUNT|SHN-1"].gun_number).toBeTruthy();
  });

  it("404 for an unknown matrix", async () => {
    const out = await run(recompute, { method: "POST", query: { id: "nope" } });
    expect(out.statusCode).toBe(404);
  });
});

describe("recommended PATCH (PR4)", () => {
  it("edits an editable field and returns the row", async () => {
    const out = await run(patchRec, { method: "PATCH", query: { id: "m1" }, body: { row_id: "e1", recommended_qty: 750, priority: "Medium" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.row.recommended_qty).toBe(750);
    expect(out.body.row.priority).toBe("Medium");
  });
  it("404 when the row is missing", async () => {
    const out = await run(patchRec, { method: "PATCH", query: { id: "m1" }, body: { row_id: "zzz", recommended_qty: 1 } });
    expect(out.statusCode).toBe(404);
  });
});
