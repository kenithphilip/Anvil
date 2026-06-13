// Unit tests for the pure composition-recipe → BOM helpers
// (src/api/_lib/composition-recipe.js).

import { describe, it, expect } from "vitest";
import { resolveConsumption, recipeToBomRows } from "../api/_lib/composition-recipe.js";

describe("resolveConsumption", () => {
  it("prefers an explicit consumption_per_unit", () => {
    expect(resolveConsumption({ consumption_per_unit: 1.4, gross_qty: 9 })).toBe(1.4);
  });
  it("derives gross / yield when no explicit value", () => {
    expect(resolveConsumption({ gross_qty: 0.2, yield_pct: 0.8 })).toBeCloseTo(0.25, 6);
  });
  it("falls back to gross when yield is absent or invalid", () => {
    expect(resolveConsumption({ gross_qty: 2 })).toBe(2);
    expect(resolveConsumption({ gross_qty: 2, yield_pct: 0 })).toBe(2);
    expect(resolveConsumption({ gross_qty: 2, yield_pct: 1.5 })).toBe(2);
  });
  it("returns 0 for unusable input", () => {
    expect(resolveConsumption(null)).toBe(0);
    expect(resolveConsumption({})).toBe(0);
  });
});

describe("recipeToBomRows", () => {
  it("maps finished→raw with consumption as BOM qty", () => {
    const rows = recipeToBomRows([
      { finished_part_no: "GUN-1", raw_material_part_no: "STEEL", consumption_per_unit: 1.4, uom: "kg" },
      { finished_part_no: "GUN-1", raw_material_part_no: "COATING", gross_qty: 0.2, yield_pct: 0.8, uom: "kg" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.child_part_no === "STEEL")).toMatchObject({ parent_part_no: "GUN-1", qty: 1.4, uom: "kg" });
    expect(rows.find((r) => r.child_part_no === "COATING").qty).toBeCloseTo(0.25, 6);
  });

  it("aggregates the same raw material used twice on one finished part", () => {
    const rows = recipeToBomRows([
      { finished_part_no: "GUN-1", raw_material_part_no: "STEEL", consumption_per_unit: 1.0 },
      { finished_part_no: "GUN-1", raw_material_part_no: "STEEL", consumption_per_unit: 0.5 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(1.5);
  });

  it("skips lines missing an end or with non-positive consumption", () => {
    const rows = recipeToBomRows([
      { raw_material_part_no: "STEEL", consumption_per_unit: 1 },      // no parent
      { finished_part_no: "GUN-1", consumption_per_unit: 1 },          // no child
      { finished_part_no: "GUN-1", raw_material_part_no: "X", consumption_per_unit: 0 }, // zero
    ]);
    expect(rows).toHaveLength(0);
  });
});
