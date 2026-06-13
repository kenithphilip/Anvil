// Tests for P3 raw-material price reference: the resolver
// (_lib/material-prices.js), the CRUD endpoint
// (admin/material_price_references.js), and the integration where the
// composition endpoint auto-fills a material line's unit_cost from it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveMaterialPrice } from "../api/_lib/material-prices.js";

// ── Resolver (own inline svc) ───────────────────────────────────────────
const svcWith = (refs) => ({
  from: () => {
    const f = {};
    const api = {
      select: () => api,
      eq: (c, v) => { f[c] = v; return api; },
      then: (resolve) => resolve({ data: refs.filter((r) => r.material_key === f.material_key), error: null }),
    };
    return api;
  },
});

describe("resolveMaterialPrice", () => {
  it("resolves by part_no, preferring the requested uom and latest as_of", async () => {
    const svc = svcWith([
      { material_key: "STEEL-EN8", uom: "kg", unit_price: 70, currency: "INR", as_of: "2026-05-01" },
      { material_key: "STEEL-EN8", uom: "kg", unit_price: 82, currency: "INR", as_of: "2026-06-01" },
      { material_key: "STEEL-EN8", uom: "ton", unit_price: 80000, currency: "INR", as_of: "2026-06-10" },
    ]);
    const out = await resolveMaterialPrice(svc, "t-1", { partNo: "STEEL-EN8", uom: "kg" });
    expect(out).toMatchObject({ unit_price: 82, uom: "kg" });
  });

  it("falls back to grade when the part_no has no reference", async () => {
    const svc = svcWith([{ material_key: "EN8", uom: "kg", unit_price: 75, currency: "INR", as_of: "2026-06-01" }]);
    const out = await resolveMaterialPrice(svc, "t-1", { partNo: "STEEL-XX", grade: "EN8", uom: "kg" });
    expect(out.unit_price).toBe(75);
  });

  it("returns null when nothing matches", async () => {
    expect(await resolveMaterialPrice(svcWith([]), "t-1", { partNo: "X", grade: "Y" })).toBeNull();
  });
});

// ── Shared store for the endpoints ──────────────────────────────────────
const H = vi.hoisted(() => {
  const tables = {}; let idc = 0;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = []; let op = "select", payload = null, conflict = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "insert") { const a = Array.isArray(payload) ? payload : [payload]; const ins = a.map((p) => { const r = { id: "id-" + (++idc), ...clone(p) }; tables[table].push(r); return clone(r); }); return { data: ins, error: null, __rows: ins }; }
      if (op === "upsert") { const keys = (conflict || "").split(",").map((s) => s.trim()); const ex = keys.length ? tables[table].find((r) => keys.every((k) => r[k] === payload[k])) : null; if (ex) { Object.assign(ex, clone(payload)); return { data: [clone(ex)], error: null, __rows: [clone(ex)] }; } const r = { id: "id-" + (++idc), ...clone(payload) }; tables[table].push(r); return { data: [clone(r)], error: null, __rows: [clone(r)] }; }
      if (op === "delete") { const rs = rows(); tables[table] = tables[table].filter((r) => !rs.includes(r)); return { data: null, error: null }; }
      return { data: rows().map(clone), error: null };
    };
    const api = {
      select: () => api, insert: (p) => { op = "insert"; payload = p; return api; },
      upsert: (p, o) => { op = "upsert"; payload = p; conflict = o && o.onConflict; return api; },
      delete: () => { op = "delete"; return api; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return api; }, order: () => api,
      single: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: rs[0] ? null : { message: "no rows" } }); },
      maybeSingle: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: null }); },
      then: (resolve, reject) => { try { resolve(exec()); } catch (e) { reject(e); } },
    };
    return api;
  }
  return { tables, from, reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; }, seed(t, rs) { (tables[t] = tables[t] || []).push(...rs.map(clone)); } };
});
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })), requirePermission: vi.fn(() => {}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));
const { default: refHandler } = await import("../api/admin/material_price_references.js");
const { default: compHandler } = await import("../api/admin/composition_material_lines.js");

const call = async (handler, { method, query = {}, body }) => {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = JSON.stringify(o); return this; }, send(p) { this.body = p; return this; }, end() { return this; } };
  await handler({ method, headers: {}, query, body }, res);
  let p = null; try { p = res.body ? JSON.parse(res.body) : null; } catch (_) { p = res.body; } return { res, parsed: p };
};

describe("/api/admin/material_price_references", () => {
  beforeEach(() => H.reset());
  it("upserts and lists a reference", async () => {
    const a = await call(refHandler, { method: "POST", body: { material_key: "STEEL-EN8", uom: "kg", unit_price: 82, currency: "INR" } });
    expect(a.res.statusCode).toBe(200);
    expect(a.parsed.reference).toMatchObject({ material_key: "STEEL-EN8", unit_price: 82 });
    const g = await call(refHandler, { method: "GET", query: { material_key: "STEEL-EN8" } });
    expect(g.parsed.references).toHaveLength(1);
  });
  it("rejects a missing key or non-numeric price", async () => {
    expect((await call(refHandler, { method: "POST", body: { unit_price: 1 } })).res.statusCode).toBe(400);
    expect((await call(refHandler, { method: "POST", body: { material_key: "X" } })).res.statusCode).toBe(400);
  });
});

describe("composition auto-fills unit_cost from the market reference", () => {
  beforeEach(() => H.reset());
  it("fills a material line's unit_cost when none is supplied", async () => {
    H.seed("material_price_references", [{ tenant_id: "t-1", material_key: "STEEL-EN8", uom: "kg", unit_price: 82, currency: "INR", as_of: "2026-06-01" }]);
    const { res } = await call(compHandler, { method: "POST", body: { quote_id: "q-1", lines: [
      { composition_line_index: 0, seq: 0, finished_part_no: "GUN-1", raw_material_part_no: "STEEL-EN8", uom: "kg", consumption_per_unit: 1.4 },
    ] } });
    expect(res.statusCode).toBe(200);
    const saved = H.tables.composition_material_lines[0];
    expect(saved.unit_cost).toBe(82);
    expect(saved.currency).toBe("INR");
  });
  it("does not override an explicit unit_cost", async () => {
    H.seed("material_price_references", [{ tenant_id: "t-1", material_key: "STEEL-EN8", uom: "kg", unit_price: 82, currency: "INR", as_of: "2026-06-01" }]);
    await call(compHandler, { method: "POST", body: { quote_id: "q-1", lines: [
      { composition_line_index: 0, seq: 0, finished_part_no: "GUN-1", raw_material_part_no: "STEEL-EN8", uom: "kg", consumption_per_unit: 1.4, unit_cost: 99 },
    ] } });
    expect(H.tables.composition_material_lines[0].unit_cost).toBe(99);
  });
});
