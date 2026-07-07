// Spare-matrix min/max policy + auto item-type classifier.

import { describe, it, expect } from "vitest";
import { classifyItemType, classifyPolicy, computeMinMax } from "../api/_lib/spare-minmax.js";

describe("classifyItemType", () => {
  it("copper wear parts -> Consumable", () => {
    expect(classifyItemType({ description: "CAP TIP" })).toBe("Consumable");
    expect(classifyItemType({ description: "SHANK (MOVING)" })).toBe("Consumable");
    expect(classifyItemType({ description: "SHUNT" })).toBe("Consumable");
    expect(classifyItemType({ description: "ELECTRODE" })).toBe("Consumable");
  });
  it("expensive assemblies -> Spare", () => {
    expect(classifyItemType({ description: "GEAR CASE ASSY" })).toBe("Spare");
    expect(classifyItemType({ description: "TRANSFORMER" })).toBe("Spare");
    expect(classifyItemType({ description: "TR BOX ASSY" })).toBe("Spare");
    expect(classifyItemType({ description: "MOVABLE YOKE ASSY" })).toBe("Spare");
  });
  it("falls back to the column category, else Spare", () => {
    expect(classifyItemType({ description: "MYSTERY PART", category: "Consumable" })).toBe("Consumable");
    expect(classifyItemType({ description: "MYSTERY PART" })).toBe("Spare");
  });
});

describe("computeMinMax — bulk (consumables, near installed)", () => {
  it("holds ~installed .. 1.5x for copper consumables", () => {
    const r = computeMinMax({ installed_qty: 10, item_type: "Consumable", description: "CAP TIP" });
    expect(r.policy).toBe("bulk");
    expect(r.recommended_min).toBe(10);   // ~installed
    expect(r.recommended_max).toBe(15);   // 1.5x
  });
  it("Wear Part is also bulk", () => {
    expect(computeMinMax({ installed_qty: 4, item_type: "Wear Part", description: "TIP BASE" }).policy).toBe("bulk");
  });
});

describe("computeMinMax — expensive (gear case / transformer, low)", () => {
  it("keeps ~2 or less, scaled a little by installed", () => {
    expect(computeMinMax({ installed_qty: 1, item_type: "Spare", description: "GEAR CASE ASSY" })).toMatchObject({ recommended_min: 1, recommended_max: 1, policy: "expensive" });
    expect(computeMinMax({ installed_qty: 10, item_type: "Spare", description: "TRANSFORMER" })).toMatchObject({ recommended_min: 1, recommended_max: 2 });
    expect(computeMinMax({ installed_qty: 20, item_type: "Spare", description: "GEAR CASE ASSY" }).recommended_max).toBe(4); // capped
  });
  it("expensive keyword forces low policy even if mis-typed Consumable", () => {
    expect(classifyPolicy({ item_type: "Consumable", description: "GEAR CASE ASSY" })).toBe("expensive");
  });
  it("installed 0 -> 0/0", () => {
    expect(computeMinMax({ installed_qty: 0, item_type: "Spare", description: "TRANSFORMER" })).toMatchObject({ recommended_min: 0, recommended_max: 0 });
  });
});
