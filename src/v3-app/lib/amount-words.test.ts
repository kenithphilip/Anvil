import { describe, it, expect } from "vitest";
import { amountInWords } from "./amount-words";

// The Northwind sales order voucher 440 renders this exact phrase under
// "Amount Chargeable (in words)". Keep the test pinned to that input
// so a regression on the helper is caught immediately.
describe("amountInWords", () => {
  it("defaults to Indian numbering for INR (the Northwind SO sample)", () => {
    expect(amountInWords(230_202))
      .toBe("Two Lakh Thirty Thousand Two Hundred Two INR Only");
  });
  it("renders the same Northwind value in international numbering when style:intl is forced", () => {
    expect(amountInWords(230_202, { style: "intl" }))
      .toBe("Two Hundred Thirty Thousand Two Hundred Two INR Only");
  });
  it("renders the Meridian PO grand total in Indian numbering by default for INR", () => {
    expect(amountInWords(271_638.36))
      .toBe("Two Lakh Seventy One Thousand Six Hundred Thirty Eight and Thirty Six Paise INR Only");
  });
  it("renders the Meridian PO grand total in international numbering when style:intl is forced", () => {
    expect(amountInWords(271_638.36, { style: "intl" }))
      .toBe("Two Hundred Seventy One Thousand Six Hundred Thirty Eight and Thirty Six Paise INR Only");
  });
  it("handles zero", () => {
    expect(amountInWords(0)).toBe("Zero INR Only");
  });
  it("defaults to international numbering for non-INR currencies", () => {
    expect(amountInWords(1500, { currency: "USD" })).toBe("One Thousand Five Hundred USD Only");
  });
  it("respects an explicit style:indian even for non-INR currencies", () => {
    expect(amountInWords(230_202, { currency: "USD", style: "indian" }))
      .toBe("Two Lakh Thirty Thousand Two Hundred Two USD Only");
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
