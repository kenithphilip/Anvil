import { describe, it, expect } from "vitest";
import { validateValidityDays } from "../api/admin/quote_settings.js";

describe("quote_settings validateValidityDays", () => {
  it("accepts a whole number in range", () => {
    expect(validateValidityDays(45)).toEqual({ value: 45 });
    expect(validateValidityDays("60")).toEqual({ value: 60 });
  });
  it("treats null / empty as cleared (fall back to 30)", () => {
    expect(validateValidityDays(null)).toEqual({ value: null });
    expect(validateValidityDays("")).toEqual({ value: null });
    expect(validateValidityDays(undefined)).toEqual({ value: null });
  });
  it("rejects non-integers", () => {
    expect(validateValidityDays(12.5).error).toMatch(/whole number/);
    expect(validateValidityDays("abc").error).toMatch(/whole number/);
  });
  it("rejects out-of-range values", () => {
    expect(validateValidityDays(0).error).toMatch(/between 1 and 3650/);
    expect(validateValidityDays(4000).error).toMatch(/between 1 and 3650/);
  });
});
