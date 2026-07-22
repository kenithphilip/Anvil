// PDM raw-material determination. The make/buy GATE is the point: a bought-out
// part must return recipe = null so the demand explosion never forecasts raw
// material for parts we don't machine. Plus material normalization + form /
// stock-size / gross-mass logic for the parts we DO make.

import { describe, it, expect } from "vitest";
import {
  normalizeMaterial, classifyMakeBuy, classifyGeometry, inferStock, determineRawMaterial,
} from "../api/_lib/pdm/raw-material-infer.js";

describe("normalizeMaterial", () => {
  it("resolves nomenclature (incl. CrCu) to a grade + density, token-based", () => {
    expect(normalizeMaterial("CrCu")).toMatchObject({ grade: "CuCrZr", density: 8900, matched: true });
    expect(normalizeMaterial("EN8 BRIGHT BAR")).toMatchObject({ grade: "EN8", matched: true });
    expect(normalizeMaterial("SS 304")).toMatchObject({ grade: "SS304", matched: true });
    expect(normalizeMaterial("MS PLATE")).toMatchObject({ grade: "MS", matched: true });
  });
  it("does not false-match a substring (SOMSTUFF is not MS)", () => {
    expect(normalizeMaterial("SOMSTUFF").matched).toBe(false);
  });
  it("returns unmatched for unknown/empty callouts", () => {
    expect(normalizeMaterial("UNOBTAINIUM").matched).toBe(false);
    expect(normalizeMaterial("").matched).toBe(false);
  });
});

describe("classifyMakeBuy — the gate", () => {
  it("flags explicit bought-out and BOP/standard categories as BUY", () => {
    expect(classifyMakeBuy({ is_bought_out: true }).procurement_type).toBe("buy");
    expect(classifyMakeBuy({ std_category: "BOP" }).procurement_type).toBe("buy");
    expect(classifyMakeBuy({ std_category: "Standard Part" }).procurement_type).toBe("buy");
  });
  it("classifies standard hardware descriptions as BUY", () => {
    expect(classifyMakeBuy({ description: "Deep groove ball bearing 6204" }).procurement_type).toBe("buy");
    expect(classifyMakeBuy({ description: "M8 hex bolt" }).procurement_type).toBe("buy");
    expect(classifyMakeBuy({ description: "Oil seal 25x40x7" }).procurement_type).toBe("buy");
  });
  it("classifies a part with a material callout as MAKE", () => {
    const r = classifyMakeBuy({ material: "CrCu", description: "Electrode shank" });
    expect(r.procurement_type).toBe("make");
  });
  it("treats RAW_MATERIAL item_type as raw material (not a recipe target)", () => {
    expect(classifyMakeBuy({ item_type: "RAW_MATERIAL" }).procurement_type).toBe("raw_material");
  });
  it("DEFAULTS TO BUY when uncertain, so raw-material demand is never fabricated", () => {
    const r = classifyMakeBuy({ description: "widget" }); // no material, no signal
    expect(r.procurement_type).toBe("buy");
    expect(r.reason).toMatch(/over-forecasting|default/i);
  });
});

describe("classifyGeometry", () => {
  it("rotational from diameter + length", () => {
    expect(classifyGeometry({ diameter: 25, length: 110 })).toBe("rotational");
  });
  it("flat when the thinnest dim is much smaller", () => {
    expect(classifyGeometry({ length: 100, width: 80, thickness: 5 })).toBe("flat");
  });
  it("prismatic when the three dims are comparable", () => {
    expect(classifyGeometry({ length: 60, width: 50, height: 40 })).toBe("prismatic");
  });
  it("unknown when dims are insufficient", () => {
    expect(classifyGeometry({ length: 60 })).toBe("unknown");
  });
});

describe("inferStock (make parts only)", () => {
  it("rod stock from a rotational part, with allowance + gross mass", () => {
    // CrCu Ø25 × L110, 3mm allowance -> stock Ø31 × 113
    const s = inferStock({ density: 8900, dimensions: { diameter: 25, length: 110 }, geometryClass: "rotational", allowanceMm: 3 });
    expect(s.form).toBe("rod");
    expect(s.stock_dims).toEqual({ diameter: 31, length: 113 });
    expect(s.gross_mass_kg).toBeCloseTo(0.76, 1); // π/4·31²·113·1e-9·8900
    expect(s.consumption_per_unit_kg).toBeGreaterThan(s.gross_mass_kg); // gross / yield
  });
  it("block stock from a prismatic part", () => {
    const s = inferStock({ density: 7850, dimensions: { length: 60, width: 50, height: 40 }, geometryClass: "prismatic", allowanceMm: 2 });
    expect(s.form).toBe("block");
    expect(s.stock_dims).toEqual({ length: 62, width: 52, height: 42 });
  });
  it("falls back to casting + a warning when geometry/dims are insufficient", () => {
    const s = inferStock({ density: 7200, dimensions: {}, geometryClass: "unknown" });
    expect(s.form).toBe("casting");
    expect(s.gross_mass_kg).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/casting|insufficient|missing/i);
  });
});

describe("determineRawMaterial — end to end", () => {
  it("a bought-out bearing returns NO recipe (the invariant that prevents over-forecasting)", () => {
    const r = determineRawMaterial({ description: "Ball bearing 6204", part_no: "BRG-6204" });
    expect(r.procurement_type).toBe("buy");
    expect(r.recipe).toBeNull();
  });

  it("a machined CrCu shank returns a full raw-material recipe", () => {
    const r = determineRawMaterial({
      material: "CrCu", description: "Weld gun shank", item_type: "GUN_COMPONENT",
      dimensions: { diameter: 25, length: 110 }, allowanceMm: 3, yieldPct: 0.85,
    });
    expect(r.procurement_type).toBe("make");
    expect(r.recipe).toMatchObject({
      material: "CuCrZr", material_matched: true, density: 8900,
      geometry_class: "rotational", form: "rod", uom: "kg",
    });
    expect(r.recipe.stock_dims).toEqual({ diameter: 31, length: 113 });
    expect(r.recipe.gross_mass_kg).toBeGreaterThan(0);
  });

  it("a make part with an unknown material still recipes but warns to confirm the grade", () => {
    const r = determineRawMaterial({ material: "SUPERSTEEL-X", dimensions: { diameter: 10, length: 50 } });
    expect(r.procurement_type).toBe("make");
    expect(r.recipe.material_matched).toBe(false);
    expect(r.recipe.density).toBeNull();
    expect(r.recipe.gross_mass_kg).toBeNull(); // no density -> mass not fabricated
    expect(r.warnings.join(" ")).toMatch(/grade master|density/i);
  });

  it("an uncertain part defaults to buy with no recipe", () => {
    const r = determineRawMaterial({ description: "misc item" });
    expect(r.procurement_type).toBe("buy");
    expect(r.recipe).toBeNull();
  });
});
