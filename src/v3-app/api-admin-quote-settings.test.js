import { describe, it, expect } from "vitest";
import { validateValidityDays, validateOptionList } from "../api/admin/quote_settings.js";

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

describe("quote_settings validateOptionList", () => {
  it("trims, drops blanks, dedups case-insensitively", () => {
    expect(validateOptionList("units", [" NO ", "no", "SET", "", "Set"]))
      .toEqual({ value: ["NO", "SET"] });
  });
  it("treats null as an empty list", () => {
    expect(validateOptionList("units", null)).toEqual({ value: [] });
  });
  it("rejects a non-array", () => {
    expect(validateOptionList("units", "NO").error).toMatch(/must be an array/);
  });
  it("rejects non-string entries", () => {
    expect(validateOptionList("units", ["NO", 5]).error).toMatch(/must be strings/);
  });
  it("rejects an over-long value", () => {
    expect(validateOptionList("units", ["x".repeat(65)]).error).toMatch(/64 characters/);
  });
});
