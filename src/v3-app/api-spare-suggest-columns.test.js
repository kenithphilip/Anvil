// Spare-matrix column suggester: pure grouping (categoryOf / suggestColumnsFromLines)
// + the /suggest_columns endpoint (asset_code resolution, tenant scope, existing-col
// suppression, empty-BOM case). In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { categoryOf, suggestColumnsFromLines } from "../api/_lib/spare-suggest.js";

describe("categoryOf", () => {
  it("prefers std_category (uppercased)", () => {
    expect(categoryOf({ std_category: "Cap Tip", part_name: "whatever" })).toBe("CAP TIP");
  });
  it("falls back to part_name prefix, stopping at a size/number token", () => {
    expect(categoryOf({ part_name: "SHUNT 16MM COPPER" })).toBe("SHUNT");
    expect(categoryOf({ part_name: "SHANK (MOVING)" })).toBe("SHANK (MOVING)");
    expect(categoryOf({ part_name: "" })).toBe("");
  });
});

describe("suggestColumnsFromLines", () => {
  const lines = [
    { asset_id: "a1", part_no: "T-16", part_name: "CAP TIP 16MM", std_category: "CAP TIP", is_spare: false },
    { asset_id: "a2", part_no: "T-13", part_name: "CAP TIP 13MM", std_category: "CAP TIP", is_spare: false },
    { asset_id: "a1", part_no: "SH-1", part_name: "SHUNT", std_category: "SHUNT", is_spare: true },
    { asset_id: "a1", part_no: "GB-1", part_name: "GEAR CASE ASSY", std_category: "GEAR CASE", is_spare: true },
  ];
  it("groups by category, counts distinct guns + parts, ranks by gun_count", () => {
    const s = suggestColumnsFromLines(lines, []);
    const tip = s.find((x) => x.col_name === "CAP TIP");
    expect(tip.gun_count).toBe(2);      // a1 + a2
    expect(tip.part_count).toBe(2);     // T-16 + T-13
    expect(s[0].col_name).toBe("CAP TIP"); // highest gun_count first
  });
  it("classifies col_type (consumable vs spare) + suppresses existing columns", () => {
    const s = suggestColumnsFromLines(lines, ["shunt"]);   // case-insensitive suppression
    expect(s.find((x) => x.col_name === "SHUNT")).toBeUndefined();
    expect(s.find((x) => x.col_name === "CAP TIP").col_type).toBe("consumable");
    expect(s.find((x) => x.col_name === "GEAR CASE").col_type).toBe("spare");
  });
});

// ---- endpoint ----
const H = vi.hoisted(() => ({ store: {} }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rows = () => H.store[table];
      const q = {
        _f: [], _limit: null,
        select() { return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        in(c, arr) { this._f.push((r) => arr.includes(r[c])); return this; },
        limit(n) { this._limit = n; return this; },
        _exec(single) {
          let hit = rows().filter((r) => this._f.every((fn) => fn(r)));
          if (this._limit != null) hit = hit.slice(0, this._limit);
          return Promise.resolve({ data: single ? (hit[0] || null) : hit, error: null });
        },
        maybeSingle() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        then(res, rej) { return this._exec(0).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: suggestCols } = await import("../api/spare_matrix/suggest_columns.js");
const run = async (query = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await suggestCols({ method: "GET", headers: {}, url: "/api/spare_matrix/m1/suggest_columns", query, body: {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.store = {
    spare_matrix: [{ id: "m1", tenant_id: "t-1" }, { id: "m9", tenant_id: "t-2" }],
    spare_matrix_rows: [
      { tenant_id: "t-1", matrix_id: "m1", gun_no: "G1", bom_asset_id: null },
      { tenant_id: "t-1", matrix_id: "m1", gun_no: "G2", bom_asset_id: null },
    ],
    spare_matrix_columns: [{ tenant_id: "t-1", matrix_id: "m1", col_name: "SHUNT" }],
    bom_assets: [
      { id: "a1", tenant_id: "t-1", asset_code: "G1" },
      { id: "a2", tenant_id: "t-1", asset_code: "G2" },
      { id: "a9", tenant_id: "t-2", asset_code: "G1" }, // other tenant, must be excluded
    ],
    bom_lines: [
      { tenant_id: "t-1", asset_id: "a1", part_no: "T-16", part_name: "CAP TIP", std_category: "CAP TIP", is_spare: false },
      { tenant_id: "t-1", asset_id: "a2", part_no: "T-13", part_name: "CAP TIP", std_category: "CAP TIP", is_spare: false },
      { tenant_id: "t-1", asset_id: "a1", part_no: "SH-1", part_name: "SHUNT", std_category: "SHUNT", is_spare: true },
      { tenant_id: "t-2", asset_id: "a9", part_no: "X", part_name: "OTHER TENANT", std_category: "SECRET", is_spare: true }, // must not leak
    ],
  };
});

describe("suggest_columns endpoint", () => {
  it("resolves guns by asset_code, groups BOM parts, suppresses existing columns", async () => {
    const out = await run({ id: "m1" });
    expect(out.statusCode).toBe(200);
    expect(out.body.scanned_guns).toBe(2);
    const names = out.body.suggestions.map((s) => s.col_name);
    expect(names).toContain("CAP TIP");
    expect(names).not.toContain("SHUNT");   // already a column
    expect(names).not.toContain("SECRET");  // other tenant's line
    expect(out.body.suggestions.find((s) => s.col_name === "CAP TIP").gun_count).toBe(2);
  });

  it("returns a helpful note when the guns have no BOMs", async () => {
    H.store.bom_assets = [];
    const out = await run({ id: "m1" });
    expect(out.statusCode).toBe(200);
    expect(out.body.suggestions).toHaveLength(0);
    expect(out.body.note).toMatch(/no boms found/i);
  });

  it("404s a matrix from another tenant", async () => {
    const out = await run({ id: "m9" });
    expect(out.statusCode).toBe(404);
  });
});
