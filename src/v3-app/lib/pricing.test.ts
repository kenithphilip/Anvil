import { describe, it, expect } from "vitest";
import {
  composePrice,
  PROFILE_COMPACT,
  PROFILE_GRANULAR,
  DEFAULT_FX,
  type PricingProfile,
  type FxSnapshot,
} from "./pricing";

// The two profiles are validated against the real Obara spreadsheets.
// If these numbers drift, the engine no longer matches the sheets it
// was modelled on.

describe("composePrice — granular profile reproduces the PROJECT-FOR sheet", () => {
  // Sheet row 20: Korean servo gun, supplier 8000 USD, spot 83.3,
  // packing 150 USD/unit, shipping 50000 INR, insurance 1.125%,
  // duty 10%, SWT 10% of duty, CHA 0.3%, transport 1%, install 1%,
  // margin 10%. Sheet results: CIF 737,095.07; landed 820,630.05;
  // total expenses (loaded) 837,124.72; selling 930,138.57.
  const fx: FxSnapshot = { base: "INR", rates: { INR: 1, USD: 83.3, CNY: 12 } };
  const profile: PricingProfile = {
    ...PROFILE_GRANULAR,
    components: PROFILE_GRANULAR.components.map((c) =>
      c.code === "packing" ? { ...c, amount: 150 } : c.code === "shipping" ? { ...c, amount: 50000 } : c
    ),
  };

  it("matches CIF, landed cost, loaded cost and selling price", () => {
    const r = composePrice(profile, { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD" }, fx);
    const sub = (code: string) => r.waterfall.find((s) => s.code === code)!.subtotal;
    expect(sub("insurance")).toBeCloseTo(737095.07, 1); // CIF
    expect(sub("cha")).toBeCloseTo(820630.05, 1); // landed
    expect(r.perUnit.loadedCost).toBeCloseTo(837124.72, 1); // total expenses
    expect(r.perUnit.finalPrice).toBeCloseTo(930138.57, 1); // selling (no discount)
    expect(r.marginTarget).toBeCloseTo(0.1, 6);
    expect(r.marginRealized).toBeCloseTo(0.1, 4);
  });

  it("flags discount-driven profit churn below target", () => {
    // A 3% customer discount pulls the sheet's realized GP to ~7.2%.
    const r = composePrice(
      profile,
      { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD", discountPct: 0.03 },
      fx
    );
    expect(r.marginRealized).toBeCloseTo(0.0722, 3);
    expect(r.warnings.some((w) => w.code === "below_target")).toBe(true);
  });
});

describe("composePrice — compact profile reproduces the SPARES sheet", () => {
  // Sheet row 21: cap tip, supplier 0.85 USD, loaded factor 129.4,
  // 30% margin. Landed 109.99; target unit price 158 (ROUNDUP).
  it("matches landed cost and margin-derived selling", () => {
    const r = composePrice(PROFILE_COMPACT, { qty: 1, supplierUnitPrice: 0.85, supplierCurrency: "USD" }, DEFAULT_FX);
    expect(r.perUnit.loadedCost).toBeCloseTo(109.99, 2);
    expect(Math.ceil(r.perUnit.finalPrice)).toBe(158);
    expect(r.marginRealized).toBeCloseTo(0.304, 2);
  });

  it("uses the source currency's loaded factor (JPY)", () => {
    // Sheet row 26: shunt, supplier 30000 JPY, loaded factor 1.08.
    const r = composePrice(PROFILE_COMPACT, { qty: 1, supplierUnitPrice: 30000, supplierCurrency: "JPY" }, DEFAULT_FX);
    expect(r.perUnit.loadedCost).toBeCloseTo(32400, 0);
  });
});

describe("composePrice — guardrails", () => {
  it("blocks below the margin floor", () => {
    // Heavy discount drops realized margin under the 5% floor.
    const profile = { ...PROFILE_GRANULAR, components: PROFILE_GRANULAR.components };
    const r = composePrice(
      profile,
      { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD", discountPct: 0.1 },
      { base: "INR", rates: { INR: 1, USD: 83.3 } }
    );
    expect(r.warnings.some((w) => w.code === "below_floor")).toBe(true);
    expect(r.warnings.find((w) => w.code === "below_floor")!.severity).toBe("high");
  });

  it("warns when supplier price is missing", () => {
    const r = composePrice(PROFILE_COMPACT, { qty: 1, supplierUnitPrice: 0, supplierCurrency: "USD" }, DEFAULT_FX);
    expect(r.warnings.some((w) => w.code === "missing_supplier_price")).toBe(true);
  });

  it("warns when no exchange rate exists for the currency", () => {
    const r = composePrice(
      PROFILE_COMPACT,
      { qty: 1, supplierUnitPrice: 100, supplierCurrency: "EUR" },
      { base: "INR", rates: { INR: 1, USD: 83.3 } }
    );
    expect(r.warnings.some((w) => w.code === "missing_fx_rate")).toBe(true);
  });

  it("warns when the fx snapshot is stale", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    const r = composePrice(
      PROFILE_COMPACT,
      { qty: 1, supplierUnitPrice: 100, supplierCurrency: "USD" },
      { ...DEFAULT_FX, asOf: old }
    );
    expect(r.warnings.some((w) => w.code === "fx_stale")).toBe(true);
  });

  it("warns when the supplier quote has expired", () => {
    const expired = new Date(Date.now() - 5 * 86400000).toISOString();
    const r = composePrice(
      PROFILE_COMPACT,
      { qty: 1, supplierUnitPrice: 100, supplierCurrency: "USD", supplierQuoteValidTo: expired },
      DEFAULT_FX
    );
    expect(r.warnings.some((w) => w.code === "supplier_quote_expired")).toBe(true);
  });
});

describe("composePrice — config flexibility", () => {
  it("respects per-component enable toggles (drop customs duty)", () => {
    const noDuty: PricingProfile = {
      ...PROFILE_GRANULAR,
      components: PROFILE_GRANULAR.components.map((c) =>
        c.code === "customs_duty" || c.code === "social_welfare" ? { ...c, enabled: false } : c
      ),
    };
    const fx: FxSnapshot = { base: "INR", rates: { INR: 1, USD: 83.3 } };
    const withDuty = composePrice(PROFILE_GRANULAR, { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD" }, fx);
    const without = composePrice(noDuty, { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD" }, fx);
    expect(without.perUnit.loadedCost).toBeLessThan(withDuty.perUnit.loadedCost);
    expect(without.waterfall.some((s) => s.code === "customs_duty")).toBe(false);
  });

  it("computes line totals from qty", () => {
    const r = composePrice(PROFILE_COMPACT, { qty: 3, supplierUnitPrice: 0.85, supplierCurrency: "USD" }, DEFAULT_FX);
    expect(r.lineTotal).toBeCloseTo(r.perUnit.finalPrice * 3, 6);
  });
});
