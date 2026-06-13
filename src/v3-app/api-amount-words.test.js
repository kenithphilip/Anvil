// Unit tests for src/api/_lib/amount-words.js (server-side
// amount-in-words used by the ERP voucher PDF).

import { describe, it, expect } from "vitest";
import { amountInWords } from "../api/_lib/amount-words.js";

describe("amountInWords", () => {
  it("intl grouping by default", () => {
    expect(amountInWords(236, "INR")).toBe("Two Hundred Thirty Six INR Only");
    expect(amountInWords(1234, "USD")).toBe("One Thousand Two Hundred Thirty Four USD Only");
  });

  it("indian lakh/crore grouping when requested", () => {
    expect(amountInWords(230000, { currency: "INR", style: "indian" }))
      .toBe("Two Lakh Thirty Thousand INR Only");
    expect(amountInWords(10000000, { currency: "INR", style: "indian" }))
      .toBe("One Crore INR Only");
  });

  it("handles paise and zero", () => {
    expect(amountInWords(100.5, "INR")).toBe("One Hundred and Fifty Paise INR Only");
    expect(amountInWords(0, "INR")).toBe("Zero INR Only");
  });

  it("returns empty for non-numbers", () => {
    expect(amountInWords(NaN)).toBe("");
    expect(amountInWords(undefined)).toBe("");
  });
});
