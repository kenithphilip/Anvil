// Smoke test for the PR1 spare-matrix persistence layer:
//   src/api/spare_matrix/index.js  (GET list, POST create)
//   src/api/spare_matrix/[id].js   (GET full, PATCH bulk save, DELETE)
//
// Uses a tiny in-memory Supabase fake (shared store) to validate the
// CRUD + reconcile-by-id logic end to end without a real DB.

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
        _op: "select", _filters: [], _payload: null, _select: false, _single: 0,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(col, val) { this._filters.push({ t: "eq", col, val }); return this; },
        in(col, arr) { this._filters.push({ t: "in", col, arr }); return this; },
        order() { return this; },
        single() { this._single = 1; return this.then.bind(this) ? this._exec(1) : this; },
        maybeSingle() { return this._exec(2); },
        _match(r) { return this._filters.every((f) => (f.t === "eq" ? r[f.col] === f.val : f.arr.includes(r[f.col]))); },
        _exec(singleMode) {
          const store = rowsRef();
          let data = null;
          if (this._op === "select") {
            const hit = store.filter((r) => this._match(r));
            data = singleMode ? (hit[0] || null) : hit;
          } else if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => {
              if (this._op === "upsert" && it.id) {
                const ex = store.find((r) => r.id === it.id);
                if (ex) { Object.assign(ex, it); return ex; }
              }
              const rec = { id: it.id || "id-" + (++H.seq), ...it };
              store.push(rec); return rec;
            });
            data = this._select ? (singleMode ? out[0] : out) : null;
          } else if (this._op === "update") {
            store.filter((r) => this._match(r)).forEach((r) => Object.assign(r, this._payload));
            data = null;
          } else if (this._op === "delete") {
            H.store[table] = store.filter((r) => !this._match(r));
            data = null;
          }
          return Promise.resolve({ data, error: null });
        },
        then(resolve, reject) { return this._exec(this._single).then(resolve, reject); },
      };
      // single() should return a thenable that resolves the single row
      q.single = function () { this._single = 1; const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; };
      q.maybeSingle = function () { this._single = 2; const self = this; return { then: (res, rej) => self._exec(2).then(res, rej) }; };
      return q;
    },
  }),
}));

const { default: indexHandler } = await import("../api/spare_matrix/index.js");
const { default: idHandler } = await import("../api/spare_matrix/[id].js");

const run = async (handler, { method = "GET", query = {}, body } = {}) => {
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  const req = { method, headers: {}, url: "/api/spare_matrix", query };
  if (body !== undefined) req.body = body;
  await handler(req, res);
  // cors.json() serializes via res.send(string); sendError uses res.json(object).
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => { H.store = {}; H.seq = 0; });

describe("spare_matrix CRUD (PR1)", () => {
  it("creates a matrix header with tenant + created_by from ctx.user.id", async () => {
    const res = await run(indexHandler, { method: "POST", body: { customer_id: "c-1", project_name: "Pune" } });
    expect(res.statusCode).toBe(201);
    expect(res.body.matrix).toMatchObject({ tenant_id: "t-1", customer_id: "c-1", project_name: "Pune", created_by: "u-1" });
    expect(res.body.matrix.id).toBeTruthy();
  });

  it("lists matrices scoped to the tenant, filterable by customer", async () => {
    await run(indexHandler, { method: "POST", body: { customer_id: "c-1", project_name: "Pune" } });
    await run(indexHandler, { method: "POST", body: { customer_id: "c-2", project_name: "Chennai" } });
    const all = await run(indexHandler, { method: "GET", query: {} });
    expect(all.body.matrices.length).toBe(2);
    const one = await run(indexHandler, { method: "GET", query: { customer_id: "c-2" } });
    expect(one.body.matrices.length).toBe(1);
    expect(one.body.matrices[0].project_name).toBe("Chennai");
  });

  it("GET /<id> returns the four-part shape; 404 for unknown", async () => {
    const created = await run(indexHandler, { method: "POST", body: { customer_id: "c-1", project_name: "Pune" } });
    const id = created.body.matrix.id;
    const full = await run(idHandler, { method: "GET", query: { id } });
    expect(full.statusCode).toBe(200);
    expect(full.body).toHaveProperty("matrix");
    expect(full.body).toHaveProperty("columns");
    expect(full.body).toHaveProperty("rows");
    expect(full.body).toHaveProperty("recommended");
    const missing = await run(idHandler, { method: "GET", query: { id: "nope" } });
    expect(missing.statusCode).toBe(404);
  });

  it("bulk-save reconciles columns + rows by id (insert new, delete absent)", async () => {
    const created = await run(indexHandler, { method: "POST", body: { customer_id: "c-1", project_name: "Pune" } });
    const id = created.body.matrix.id;

    // First save: 2 new columns + 1 gun row (no ids).
    let saved = await run(idHandler, { method: "PATCH", query: { id }, body: {
      columns: [{ col_name: "CAP TIP", category: "Consumable", position: 0 }, { col_name: "SHANK (MOVING)", category: "Consumable", position: 1 }],
      rows: [{ gun_no: "SRTX-K16792", line: "FLR RH", station_no: "101-1R", spare_values: { "CAP TIP": "4-TP2109-1" } }],
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.columns.length).toBe(2);
    expect(saved.body.rows.length).toBe(1);
    expect(saved.body.rows[0]).toMatchObject({ gun_no: "SRTX-K16792", matrix_id: id, tenant_id: "t-1" });
    const capCol = saved.body.columns.find((c) => c.col_name === "CAP TIP");

    // Second save: keep CAP TIP (with its id), drop SHANK -> reconcile deletes it.
    saved = await run(idHandler, { method: "PATCH", query: { id }, body: {
      columns: [{ id: capCol.id, col_name: "CAP TIP", category: "Consumable", position: 0 }],
    } });
    expect(saved.body.columns.length).toBe(1);
    expect(saved.body.columns[0].col_name).toBe("CAP TIP");
    // rows were not sent -> untouched (still 1).
    expect(saved.body.rows.length).toBe(1);
  });

  it("DELETE removes the matrix", async () => {
    const created = await run(indexHandler, { method: "POST", body: { customer_id: "c-1" } });
    const id = created.body.matrix.id;
    const del = await run(idHandler, { method: "DELETE", query: { id } });
    expect(del.statusCode).toBe(200);
    expect(del.body).toEqual({ ok: true });
    const gone = await run(idHandler, { method: "GET", query: { id } });
    expect(gone.statusCode).toBe(404);
  });
});
