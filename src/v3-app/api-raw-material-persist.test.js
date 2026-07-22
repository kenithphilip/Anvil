// PDM D2: persist a reviewed raw-material verdict. A make verdict becomes a
// standalone composition_material_lines recipe + a bill_of_materials edge +
// procurement_type='make'; a buy/raw verdict only sets procurement_type (no
// recipe — a bought-out part is never forecast as raw material).

import { describe, it, expect } from "vitest";
import { rawMaterialPartNo, buildRecipeRow, persistDetermination } from "../api/_lib/pdm/raw-material-persist.js";

const NOW = "2026-07-22T00:00:00.000Z";
const MAKE = {
  procurement_type: "make",
  recipe: {
    material: "CuCrZr", density: 8900, geometry_class: "rotational", form: "rod",
    stock_dims: { diameter: 31, length: 113 }, gross_mass_kg: 0.76, yield_pct: 0.85,
    consumption_per_unit_kg: 0.89, uom: "kg",
  },
};

// Minimal in-memory svc: select/eq/is/maybeSingle + insert/update/upsert.
const makeSvc = (seed = {}) => {
  const tables = { item_master: [...(seed.item_master || [])], composition_material_lines: [], bill_of_materials: [] };
  return {
    tables,
    from(t) {
      const ds = tables[t] || (tables[t] = []);
      let rows = [...ds]; let mode = "select"; let patch = null; let single = false; let onConflict = null;
      const b = {
        select: () => b,
        eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
        is: (c, v) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        maybeSingle: () => { single = true; return b; },
        update: (p) => { mode = "update"; patch = p; return b; },
        insert: (row) => { mode = "insert"; patch = row; return b; },
        upsert: (row, opts) => { mode = "upsert"; patch = row; onConflict = opts && opts.onConflict; return b; },
        then: (fn) => Promise.resolve(fn(term())),
      };
      const term = () => {
        if (mode === "insert") { const arr = (Array.isArray(patch) ? patch : [patch]).map((r) => ({ id: t + "-" + (ds.length + 1), ...r })); ds.push(...arr); return { data: single ? arr[0] : arr, error: null }; }
        if (mode === "update") { for (const r of rows) Object.assign(r, patch); return { data: single ? rows[0] || null : rows, error: null }; }
        if (mode === "upsert") {
          const cols = (onConflict || "").split(",");
          for (const p of (Array.isArray(patch) ? patch : [patch])) {
            const ex = ds.find((r) => cols.every((c) => String(r[c]) === String(p[c])));
            if (ex) Object.assign(ex, p); else ds.push({ id: t + "-" + (ds.length + 1), ...p });
          }
          return { data: null, error: null };
        }
        return { data: single ? rows[0] || null : rows, error: null };
      };
      return b;
    },
  };
};

describe("rawMaterialPartNo", () => {
  it("builds a deterministic raw SKU from grade + form", () => {
    expect(rawMaterialPartNo("CuCrZr", "rod")).toBe("RM-CUCRZR-ROD");
    expect(rawMaterialPartNo("EN8", "block")).toBe("RM-EN8-BLOCK");
    expect(rawMaterialPartNo("SS 304", null)).toBe("RM-SS-304");
  });
});

describe("buildRecipeRow", () => {
  it("maps a make verdict to a standalone composition line", () => {
    const row = buildRecipeRow("t1", "SHANK-A", MAKE, NOW);
    expect(row).toMatchObject({
      tenant_id: "t1", quote_id: null, finished_part_no: "SHANK-A",
      raw_material_part_no: "RM-CUCRZR-ROD", material: "CuCrZr", form: "rod",
      density: 8900, gross_qty: 0.76, consumption_per_unit: 0.89, uom: "kg",
    });
    expect(row.dimensions).toEqual({ diameter: 31, length: 113 });
  });
  it("returns null for a non-make verdict", () => {
    expect(buildRecipeRow("t1", "X", { procurement_type: "buy", recipe: null }, NOW)).toBeNull();
  });
});

describe("persistDetermination", () => {
  it("make: writes the recipe + BOM edge + procurement_type=make + ensures the raw material", async () => {
    const svc = makeSvc({ item_master: [{ part_no: "SHANK-A", tenant_id: "t1" }] });
    const out = await persistDetermination(svc, "t1", { finished_part_no: "SHANK-A", verdict: MAKE }, NOW);
    expect(out).toMatchObject({ procurement_type: "make", raw_material_part_no: "RM-CUCRZR-ROD", recipe_saved: true, bom_synced: 1 });
    // finished part flagged make
    expect(svc.tables.item_master.find((r) => r.part_no === "SHANK-A").procurement_type).toBe("make");
    // recipe row (standalone, quote_id null)
    const recipe = svc.tables.composition_material_lines[0];
    expect(recipe).toMatchObject({ finished_part_no: "SHANK-A", raw_material_part_no: "RM-CUCRZR-ROD", quote_id: null, consumption_per_unit: 0.89 });
    // BOM edge finished -> raw, qty = consumption
    expect(svc.tables.bill_of_materials[0]).toMatchObject({ parent_part_no: "SHANK-A", child_part_no: "RM-CUCRZR-ROD", qty: 0.89 });
    // raw material item ensured
    expect(svc.tables.item_master.find((r) => r.part_no === "RM-CUCRZR-ROD").item_type).toBe("RAW_MATERIAL");
  });

  it("is idempotent: re-persisting updates the same standalone recipe (no duplicate)", async () => {
    const svc = makeSvc({ item_master: [{ part_no: "SHANK-A", tenant_id: "t1" }] });
    await persistDetermination(svc, "t1", { finished_part_no: "SHANK-A", verdict: MAKE }, NOW);
    await persistDetermination(svc, "t1", { finished_part_no: "SHANK-A", verdict: MAKE }, NOW);
    expect(svc.tables.composition_material_lines).toHaveLength(1);
  });

  it("buy: sets procurement_type=buy and writes NO recipe", async () => {
    const svc = makeSvc({ item_master: [{ part_no: "BRG-6204", tenant_id: "t1" }] });
    const out = await persistDetermination(svc, "t1", { finished_part_no: "BRG-6204", verdict: { procurement_type: "buy", recipe: null } }, NOW);
    expect(out).toMatchObject({ procurement_type: "buy", recipe_saved: false, bom_synced: 0 });
    expect(svc.tables.item_master.find((r) => r.part_no === "BRG-6204").procurement_type).toBe("buy");
    expect(svc.tables.composition_material_lines).toHaveLength(0);
    expect(svc.tables.bill_of_materials).toHaveLength(0);
  });

  it("rejects a missing finished_part_no or bad verdict", async () => {
    const svc = makeSvc();
    await expect(persistDetermination(svc, "t1", { finished_part_no: "", verdict: MAKE }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(persistDetermination(svc, "t1", { finished_part_no: "X", verdict: { procurement_type: "nonsense" } }, NOW)).rejects.toMatchObject({ status: 400 });
  });
});
