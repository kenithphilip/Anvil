// Handler test for src/api/admin/composition_material_lines.js — the P2
// recipe-authoring endpoint. Asserts POST upserts material lines AND
// syncs bill_of_materials + ensures RAW_MATERIAL item_master rows.
// Uses a small shared in-memory store; only auth/audit are mocked out.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tables = {};
  let idc = 0;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = []; let op = "select", payload = null, conflict = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "insert") { const a = Array.isArray(payload) ? payload : [payload]; const ins = a.map((p) => { const row = { id: p.id || "id-" + (++idc), ...clone(p) }; tables[table].push(row); return clone(row); }); return { data: ins, error: null, __rows: ins }; }
      if (op === "upsert") {
        const a = Array.isArray(payload) ? payload : [payload];
        const out = a.map((p) => {
          const keys = (conflict || "").split(",").map((s) => s.trim());
          const existing = keys.length ? tables[table].find((r) => keys.every((k) => r[k] === p[k])) : null;
          if (existing) { Object.assign(existing, clone(p)); return clone(existing); }
          const row = { id: p.id || "id-" + (++idc), ...clone(p) }; tables[table].push(row); return clone(row);
        });
        return { data: out, error: null, __rows: out };
      }
      if (op === "delete") { const rs = rows(); tables[table] = tables[table].filter((r) => !rs.includes(r)); return { data: null, error: null }; }
      return { data: rows().map(clone), error: null };
    };
    const api = {
      select: () => api, insert: (p) => { op = "insert"; payload = p; return api; },
      upsert: (p, opts) => { op = "upsert"; payload = p; conflict = opts && opts.onConflict; return api; },
      update: (p) => { op = "update"; payload = p; return api; },
      delete: () => { op = "delete"; return api; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
      order: () => api,
      single: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: rs[0] ? null : { message: "no rows" } }); },
      maybeSingle: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: null }); },
      then: (resolve, reject) => { try { resolve(exec()); } catch (e) { reject(e); } },
    };
    return api;
  }
  return { tables, from, reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; } };
});

vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })), requirePermission: vi.fn(() => {}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));

const { default: handler } = await import("../api/admin/composition_material_lines.js");

const makeRes = () => ({ statusCode: 200, headers: {}, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = JSON.stringify(o); return this; }, send(p) { this.body = p; return this; }, end() { return this; } });
const call = async ({ method, query = {}, body }) => { const res = makeRes(); await handler({ method, headers: {}, query, body }, res); let p = null; try { p = res.body ? JSON.parse(res.body) : null; } catch (_) { p = res.body; } return { res, parsed: p }; };

beforeEach(() => H.reset());

describe("POST /api/admin/composition_material_lines", () => {
  it("upserts material lines and syncs bill_of_materials + item_master", async () => {
    const { res, parsed } = await call({ method: "POST", body: { quote_id: "q-1", lines: [
      { composition_line_index: 0, seq: 0, finished_part_no: "GUN-1", raw_material_part_no: "STEEL-EN8", material: "EN8", form: "rod", consumption_per_unit: 1.4, uom: "kg" },
      { composition_line_index: 0, seq: 1, finished_part_no: "GUN-1", raw_material_part_no: "COAT-ZN", gross_qty: 0.2, yield_pct: 0.8, uom: "kg" },
    ] } });
    expect(res.statusCode).toBe(200);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.bom_synced).toBe(2);
    expect(parsed.finished_parts).toEqual(["GUN-1"]);

    // bill_of_materials populated from the recipe
    const bom = H.tables.bill_of_materials;
    expect(bom).toHaveLength(2);
    expect(bom.find((b) => b.child_part_no === "STEEL-EN8")).toMatchObject({ parent_part_no: "GUN-1", qty: 1.4 });
    expect(bom.find((b) => b.child_part_no === "COAT-ZN").qty).toBeCloseTo(0.25, 6);

    // raw materials ensured as RAW_MATERIAL item_master rows (planning opt-in)
    const items = H.tables.item_master;
    expect(items.find((i) => i.part_no === "STEEL-EN8")).toMatchObject({ item_type: "RAW_MATERIAL", planning_enabled: false });
    expect(items.find((i) => i.part_no === "COAT-ZN")).toBeTruthy();
  });

  it("re-syncs idempotently (upsert by conflict key, no duplicate BOM rows)", async () => {
    const body = { quote_id: "q-1", lines: [{ composition_line_index: 0, seq: 0, finished_part_no: "GUN-1", raw_material_part_no: "STEEL-EN8", consumption_per_unit: 1.4 }] };
    await call({ method: "POST", body });
    await call({ method: "POST", body });
    expect(H.tables.bill_of_materials).toHaveLength(1);
    expect(H.tables.composition_material_lines).toHaveLength(1);
    expect(H.tables.item_master.filter((i) => i.part_no === "STEEL-EN8")).toHaveLength(1);
  });

  it("rejects a line missing raw_material_part_no", async () => {
    const { res } = await call({ method: "POST", body: { quote_id: "q-1", lines: [{ composition_line_index: 0, finished_part_no: "GUN-1" }] } });
    expect(res.statusCode).toBe(400);
  });

  it("requires quote_id", async () => {
    const { res } = await call({ method: "POST", body: { lines: [] } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/admin/composition_material_lines", () => {
  it("returns lines for a quote", async () => {
    await call({ method: "POST", body: { quote_id: "q-1", lines: [{ composition_line_index: 0, finished_part_no: "GUN-1", raw_material_part_no: "STEEL-EN8", consumption_per_unit: 1 }] } });
    const { res, parsed } = await call({ method: "GET", query: { quote_id: "q-1" } });
    expect(res.statusCode).toBe(200);
    expect(parsed.lines).toHaveLength(1);
  });
});
