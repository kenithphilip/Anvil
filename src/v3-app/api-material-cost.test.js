// The multiply: consumption_per_unit x unit_cost = material cost per finished
// unit. Anvil computed both halves and multiplied neither, so unit_cost had no
// reader anywhere in src/.

import { describe, it, expect } from "vitest";
import { materialCostPerUnit, rollUpMaterialCost } from "../api/_lib/pdm/material-cost.js";

const line = (over = {}) => ({
  consumption_per_unit: 2.5, unit_cost: 120, uom: "kg", currency: "INR", ...over,
});

describe("materialCostPerUnit", () => {
  it("multiplies consumption by unit cost", () => {
    const c = materialCostPerUnit(line());
    expect(c.ok).toBe(true);
    expect(c.amount).toBe(300);       // 2.5 kg x 120/kg
    expect(c.currency).toBe("INR");
    expect(c.uom).toBe("kg");
  });

  it("NEVER infers zero from a missing half — an unpriced line is unpriced, not free", () => {
    const noPrice = materialCostPerUnit(line({ unit_cost: null }));
    expect(noPrice.amount).toBeNull();
    expect(noPrice.ok).toBe(false);
    expect(noPrice.reason).toBe("no_unit_cost");

    const noQty = materialCostPerUnit(line({ consumption_per_unit: null }));
    expect(noQty.amount).toBeNull();
    expect(noQty.reason).toBe("no_consumption");
  });

  it("names which half is missing so the UI can ask for the right thing", () => {
    expect(materialCostPerUnit(line({ unit_cost: "" })).reason).toBe("no_unit_cost");
    expect(materialCostPerUnit(line({ consumption_per_unit: "abc" })).reason).toBe("no_consumption");
    expect(materialCostPerUnit({}).reason).toBe("no_consumption");
    expect(materialCostPerUnit(null).reason).toBe("no_consumption");
  });

  it("refuses negative inputs rather than producing a negative cost", () => {
    expect(materialCostPerUnit(line({ consumption_per_unit: -1 })).reason).toBe("negative_consumption");
    expect(materialCostPerUnit(line({ unit_cost: -5 })).reason).toBe("negative_unit_cost");
  });

  it("REFUSES a uom mismatch — a tonne price against a kg consumption is out by 1000", () => {
    const c = materialCostPerUnit(line({ uom: "kg" }), { priceUom: "tonne" });
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("uom_mismatch");
    expect(c.amount).toBeNull();
    // and agrees when the units match (case/whitespace tolerant)
    expect(materialCostPerUnit(line(), { priceUom: " KG " }).ok).toBe(true);
  });

  it("keeps a genuine zero price distinct from a missing one", () => {
    const c = materialCostPerUnit(line({ unit_cost: 0 }));
    expect(c.ok).toBe(true);
    expect(c.amount).toBe(0);
  });
});

describe("rollUpMaterialCost", () => {
  it("sums a single-currency recipe and reports it complete", () => {
    const r = rollUpMaterialCost([
      line({ consumption_per_unit: 2, unit_cost: 100 }),   // 200
      line({ consumption_per_unit: 0.5, unit_cost: 400 }), // 200
    ]);
    expect(r.amount).toBe(400);
    expect(r.currency).toBe("INR");
    expect(r.priced_lines).toBe(2);
    expect(r.unpriced_lines).toBe(0);
    expect(r.complete).toBe(true);
    expect(r.mixed_currency).toBe(false);
  });

  it("REFUSES to add across currencies — buckets them and leaves the total null", () => {
    const r = rollUpMaterialCost([
      line({ consumption_per_unit: 2, unit_cost: 100, currency: "INR" }),
      line({ consumption_per_unit: 1, unit_cost: 8, currency: "USD" }),
    ]);
    expect(r.mixed_currency).toBe(true);
    expect(r.amount).toBeNull();
    expect(r.currency).toBeNull();
    expect(r.by_currency).toEqual([
      { currency: "INR", amount: 200 },
      { currency: "USD", amount: 8 },
    ]);
  });

  it("marks a partially-priced recipe incomplete so the total is not read as the whole part", () => {
    const r = rollUpMaterialCost([
      line({ consumption_per_unit: 2, unit_cost: 100 }),
      line({ unit_cost: null }),
    ]);
    expect(r.amount).toBe(200);
    expect(r.priced_lines).toBe(1);
    expect(r.unpriced_lines).toBe(1);
    expect(r.complete).toBe(false);
  });

  it("is safe on empty / malformed input", () => {
    expect(rollUpMaterialCost([]).amount).toBeNull();
    expect(rollUpMaterialCost([]).complete).toBe(false);
    expect(rollUpMaterialCost(null).amount).toBeNull();
  });
});

describe("an unlabelled-currency line must not join the INR total", () => {
  it("buckets a null currency as unknown and forces mixed_currency", () => {
    const r = rollUpMaterialCost([
      line({ consumption_per_unit: 2, unit_cost: 100, currency: "INR" }),
      line({ consumption_per_unit: 2, unit_cost: 8, currency: null }),
    ]);
    // Defaulting the unlabelled line to INR would have produced a confident
    // 216 that silently mixes a USD-intent rate into an INR total.
    expect(r.mixed_currency).toBe(true);
    expect(r.amount).toBeNull();
    expect(r.by_currency.map((b) => b.currency).sort()).toEqual(["?", "INR"]);
  });
});
