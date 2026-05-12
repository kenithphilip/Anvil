import { describe, it, expect } from "vitest";
import { amountInWords } from "./amount-words";

// The Obara sales order voucher 440 renders this exact phrase under
// "Amount Chargeable (in words)". Keep the test pinned to that input
// so a regression on the helper is caught immediately.
describe("amountInWords", () => {
  it("renders the Obara SO sample (intl)", () => {
    expect(amountInWords(230_202)).toBe("Two Hundred Thirty Thousand Two Hundred Two INR Only");
  });
  it("renders the same value in Indian numbering", () => {
    expect(amountInWords(230_202, { style: "indian" }))
      .toBe("Two Lakh Thirty Thousand Two Hundred Two INR Only");
  });
  it("renders the Hyundai PO grand total (intl)", () => {
    expect(amountInWords(271_638.36))
      .toBe("Two Hundred Seventy One Thousand Six Hundred Thirty Eight and Thirty Six Paise INR Only");
  });
  it("handles zero", () => {
    expect(amountInWords(0)).toBe("Zero INR Only");
  });
  it("handles non-INR currencies", () => {
    expect(amountInWords(1500, { currency: "USD" })).toBe("One Thousand Five Hundred USD Only");
  });
  it("handles negatives", () => {
    expect(amountInWords(-100)).toBe("Minus One Hundred INR Only");
  });
  it("returns empty on null", () => {
    expect(amountInWords(null)).toBe("");
  });
  it("renders 10 crore (indian)", () => {
    expect(amountInWords(100_000_000, { style: "indian" })).toBe("Ten Crore INR Only");
  });
  it("renders 1.5 crore with paise (indian)", () => {
    expect(amountInWords(15_000_000.5, { style: "indian" })).toBe("One Crore Fifty Lakh and Fifty Paise INR Only");
  });
});
