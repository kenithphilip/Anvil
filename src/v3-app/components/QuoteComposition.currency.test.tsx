// Where a quote line's currency comes from.
//
// It came from the ORIGIN COUNTRY of the part, via a hardcoded map whose own
// Korea entry gives the game away:
//
//   if (s.includes("KOR")) return "USD";   // Korea's currency is KRW
//
// "USD" there encodes the fact that one particular Korean supplier invoices in
// USD — a supplier relationship wearing a country's name. `suppliers` has
// carried `country` and `default_currency` since it was created and neither was
// ever read by this screen, so picking a supplier set only its name and id and
// left the currency at whatever the country map had guessed. Every line had to
// be corrected by hand, and an uncorrected one converted at the wrong FX rate
// into the customer's price.

import { describe, it, expect } from "vitest";
import { resolveSupplierCurrency } from "./QuoteComposition";

const META = {
  "Obara Korea": { currency: "USD", country: "KOREA" },
  "Seoul Precision": { currency: "KRW", country: "KOREA" },
  "Mumbai Distributors": { currency: "INR", country: "INDIA" },
  "No Currency Co": { country: "JAPAN" },
};

describe("resolveSupplierCurrency", () => {
  it("takes the supplier's own default currency", () => {
    expect(resolveSupplierCurrency("Mumbai Distributors", META, "JAPAN")).toBe("INR");
  });

  // The case the country map cannot express.
  it("lets two suppliers in the same country bill in different currencies", () => {
    expect(resolveSupplierCurrency("Obara Korea", META, "KOREA")).toBe("USD");
    expect(resolveSupplierCurrency("Seoul Precision", META, "KOREA")).toBe("KRW");
  });

  // Japanese-origin part bought through an Indian distributor.
  it("prefers the supplier over the part's origin country", () => {
    expect(resolveSupplierCurrency("Mumbai Distributors", META, "JAPAN")).toBe("INR");
  });

  it("falls back to the origin country when the supplier has no default", () => {
    expect(resolveSupplierCurrency("No Currency Co", META, "JAPAN")).toBe("JPY");
  });

  it("falls back for an RFQ vendor, which has no master row at all", () => {
    expect(resolveSupplierCurrency("Some RFQ Vendor", META, "CHINA")).toBe("CNY");
  });

  it("falls back when no supplier is chosen yet", () => {
    expect(resolveSupplierCurrency(undefined, META, "INDIA")).toBe("INR");
    expect(resolveSupplierCurrency("", META, "KOREA")).toBe("USD");
  });

  it("normalises case and whitespace", () => {
    expect(resolveSupplierCurrency("X", { X: { currency: " usd " } }, "INDIA")).toBe("USD");
  });

  it("ignores a blank currency rather than emitting an empty string", () => {
    // An empty currency would break the FX lookup silently.
    expect(resolveSupplierCurrency("X", { X: { currency: "   " } }, "JAPAN")).toBe("JPY");
  });

  it("defaults to INR when nothing is known", () => {
    expect(resolveSupplierCurrency(undefined, {}, undefined)).toBe("INR");
  });
});
