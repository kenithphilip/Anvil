// /api/admin/composition_material_lines: the multiply must reach the caller,
// and the market-reference auto-fill must refuse a unit mismatch.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ rows: [], ref: null, inserted: [] }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/material-prices.js", () => ({ resolveMaterialPrice: vi.fn(async () => H.ref) }));
vi.mock("../api/_lib/composition-recipe.js", () => ({ recipeToBomRows: vi.fn(() => []) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const api = {
        select: () => api, eq: () => api, order: () => api, is: () => api, delete: () => api,
        upsert(row) { H.inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: "ml-1", ...row }, error: null }) }) }; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (r) => r({ data: table === "composition_material_lines" ? H.rows : [], error: null }),
      };
      return api;
    },
  }),
}));

const { default: handler } = await import("../api/admin/composition_material_lines.js");

const run = async ({ method = "GET", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method, headers: {}, url: "/api/admin/composition_material_lines", query, body: body || {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => { H.rows = []; H.ref = null; H.inserted = []; });

describe("GET attaches the derived material cost (unit_cost finally has a reader)", () => {
  it("returns material_cost_per_unit per line and a per-composition-line rollup", async () => {
    H.rows = [
      { composition_line_index: 0, seq: 0, consumption_per_unit: 2.5, unit_cost: 120, uom: "kg", currency: "INR" },
      { composition_line_index: 0, seq: 1, consumption_per_unit: 1, unit_cost: null, uom: "kg", currency: "INR" },
    ];
    const out = await run({ query: { quote_id: "q-1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.lines[0].material_cost_per_unit).toMatchObject({ ok: true, amount: 300, currency: "INR" });
    expect(out.body.lines[1].material_cost_per_unit).toMatchObject({ ok: false, reason: "no_unit_cost", amount: null });
    const roll = out.body.material_cost.find((r) => r.composition_line_index === 0);
    expect(roll.amount).toBe(300);
    expect(roll.priced_lines).toBe(1);
    expect(roll.unpriced_lines).toBe(1);
    expect(roll.complete).toBe(false);   // a partial recipe understates the part
  });
});

describe("the market-reference auto-fill refuses a UOM mismatch", () => {
  const post = (uom) => run({
    method: "POST",
    body: { quote_id: "q-1", lines: [{ composition_line_index: 0, seq: 0, raw_material_part_no: "STEEL-EN8", material: "EN8", consumption_per_unit: 1.4, uom }] },
  });

  it("does NOT take a per-tonne price for a per-kg line (the 1000x bug)", async () => {
    H.ref = { uom: "tonne", unit_price: 82000, currency: "INR" };
    const out = await post("kg");
    expect(out.statusCode).toBe(200);
    // No rate is better than a rate 1000x out: the line stays unpriced.
    expect(H.inserted[0].unit_cost).toBeUndefined();
    expect(out.body.lines[0].material_cost_per_unit.ok).toBe(false);
  });

  it("DOES take a price whose uom matches the line", async () => {
    H.ref = { uom: "kg", unit_price: 82, currency: "INR" };
    const out = await post("kg");
    expect(H.inserted[0].unit_cost).toBe(82);
    expect(out.body.lines[0].material_cost_per_unit).toMatchObject({ ok: true, amount: 114.8 });
  });

  it("an explicitly typed rate still wins over the reference", async () => {
    H.ref = { uom: "kg", unit_price: 82, currency: "INR" };
    const out = await run({
      method: "POST",
      body: { quote_id: "q-1", lines: [{ composition_line_index: 0, seq: 0, raw_material_part_no: "STEEL-EN8", consumption_per_unit: 2, unit_cost: 100, uom: "kg", currency: "INR" }] },
    });
    expect(H.inserted[0].unit_cost).toBe(100);
    expect(out.body.lines[0].material_cost_per_unit.amount).toBe(200);
  });
});
