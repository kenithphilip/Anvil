// MEIO step 4d: /api/locations (warehouse master). Verifies tenant scope,
// location_code validation, upsert, single-default enforcement, and delete.
// In-memory Supabase fake.

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
      const rows = () => H.store[table];
      const q = {
        _op: "select", _f: [], _payload: null, _select: false,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        neq(c, v) { this._f.push((r) => r[c] !== v); return this; },
        order() { return this; },
        _match(r) { return this._f.every((fn) => fn(r)); },
        _exec(single) {
          const store = rows();
          let data = null;
          if (this._op === "select") { const hit = store.filter((r) => this._match(r)); data = single ? (hit[0] || null) : hit; }
          else if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = [];
            for (const it of items) {
              if (this._op === "upsert") { const ex = store.find((r) => r.tenant_id === it.tenant_id && r.location_code === it.location_code); if (ex) { Object.assign(ex, it); out.push(ex); continue; } }
              // Model the DB unique (tenant_id, location_code) on locations inserts.
              if (this._op === "insert" && table === "locations" && store.find((r) => r.tenant_id === it.tenant_id && r.location_code === it.location_code)) {
                return Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint" } });
              }
              const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); out.push(rec);
            }
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "update") { const hit = store.filter((r) => this._match(r)); hit.forEach((r) => Object.assign(r, this._payload)); data = this._select ? (single ? (hit[0] || null) : hit) : null; }
          else if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); }
          return Promise.resolve({ data, error: null });
        },
        single() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        maybeSingle() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        then(res, rej) { return this._exec(0).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: locations } = await import("../api/locations/index.js");
const run = async ({ method = "GET", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await locations({ method, headers: {}, url: "/api/locations", query, body: body || {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    locations: [
      { id: "l1", tenant_id: "t-1", location_code: "WH-A", name: "Warehouse A", is_default: true, active: true },
      { id: "l9", tenant_id: "t-2", location_code: "WH-X", is_default: true, active: true }, // other tenant
    ],
  };
});

describe("locations endpoint", () => {
  it("lists only this tenant's locations", async () => {
    const out = await run({ method: "GET" });
    expect(out.statusCode).toBe(200);
    expect(out.body.locations.map((l) => l.id)).toEqual(["l1"]);
  });

  it("requires location_code on POST", async () => {
    const out = await run({ method: "POST", body: { name: "no code" } });
    expect(out.statusCode).toBe(400);
  });

  it("creates a warehouse and enforces a single default (unsets the old one)", async () => {
    const out = await run({ method: "POST", body: { location_code: "WH-B", name: "Warehouse B", is_default: true } });
    expect(out.statusCode).toBe(200);
    expect(out.body.location.tenant_id).toBe("t-1");
    expect(out.body.location.is_default).toBe(true);
    // the previously-default WH-A is now unset
    expect(H.store.locations.find((l) => l.id === "l1").is_default).toBe(false);
    // the other tenant's default is untouched
    expect(H.store.locations.find((l) => l.id === "l9").is_default).toBe(true);
  });

  it("409s a duplicate location_code on create (no silent overwrite)", async () => {
    const out = await run({ method: "POST", body: { location_code: "WH-A", name: "Dup" } });
    expect(out.statusCode).toBe(409);
    // the existing WH-A is untouched (still has its name + default)
    const wha = H.store.locations.find((l) => l.id === "l1");
    expect(wha.name).toBe("Warehouse A");
    expect(wha.is_default).toBe(true);
  });

  it("deletes a location by id (tenant-scoped)", async () => {
    const out = await run({ method: "DELETE", query: { id: "l1" } });
    expect(out.statusCode).toBe(200);
    expect(H.store.locations.find((l) => l.id === "l1")).toBeUndefined();
    expect(H.store.locations.find((l) => l.id === "l9")).toBeTruthy(); // other tenant safe
  });
});
