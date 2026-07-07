// Spare-matrix min/max policy + auto item-type classifier.

import { describe, it, expect } from "vitest";
import { classifyItemType, classifyPolicy, computeMinMax, parseLeadDays } from "../api/_lib/spare-minmax.js";

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

describe("parseLeadDays", () => {
  it("parses ranges (upper bound), weeks/months/days, bare numbers", () => {
    expect(parseLeadDays("11-12 weeks")).toBe(84);  // 12 * 7
    expect(parseLeadDays("6-7 weeks")).toBe(49);
    expect(parseLeadDays("2 months")).toBe(60);
    expect(parseLeadDays("30 days")).toBe(30);
    expect(parseLeadDays("45")).toBe(45);            // bare -> days
    expect(parseLeadDays("")).toBeNull();
    expect(parseLeadDays("immediate")).toBeNull();
  });
});

describe("computeMinMax — lead time + criticality (s,S)", () => {
  it("default lead (unknown) reproduces the v1 numbers", () => {
    expect(computeMinMax({ installed_qty: 10, item_type: "Consumable", description: "CAP TIP" }))
      .toMatchObject({ recommended_min: 10, recommended_max: 15 });
  });
  it("long lead (11-12 wk import) raises consumable stock", () => {
    const r = computeMinMax({ installed_qty: 10, item_type: "Consumable", description: "CAP TIP", lead_time_days: "11-12 weeks" });
    expect(r.basis.lead_days).toBe(84);
    expect(r.basis.lead_mult).toBe(1.5);          // 84/56
    expect(r.recommended_min).toBe(15);           // ceil(10 * 1.0 * 1.5)
    expect(r.recommended_max).toBe(23);           // ceil(10 * 1.5 * 1.5)
  });
  it("short lead lowers consumable stock", () => {
    const r = computeMinMax({ installed_qty: 10, item_type: "Consumable", description: "CAP TIP", lead_time_days: "2 weeks" });
    expect(r.basis.lead_mult).toBe(0.75);         // clamped floor (14/56=0.25 -> 0.75)
    expect(r.recommended_min).toBe(8);            // ceil(10 * 0.75)
  });
  it("long lead nudges an expensive part up but stays capped", () => {
    const r = computeMinMax({ installed_qty: 10, item_type: "Spare", description: "TRANSFORMER", lead_time_days: "12 weeks" });
    expect(r.recommended_max).toBe(3);            // ceil(10 * 0.2 * 1.5) = 3, under cap 4
    expect(r.recommended_max).toBeLessThanOrEqual(4);
  });
  it("high criticality (0..100) adds safety stock", () => {
    const r = computeMinMax({ installed_qty: 10, item_type: "Consumable", description: "CAP TIP", criticality_score: 100 });
    expect(r.basis.crit_mult).toBe(1.5);
    expect(r.recommended_min).toBe(15);           // ceil(10 * 1.0 * 1 * 1.5)
  });
});
