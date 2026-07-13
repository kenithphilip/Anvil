// Unit tests for src/api/_lib/gstin.js.
//
// Coverage focuses on the Mod-36 checksum (the algorithm with the
// most fiddly bits) and the shape regex. Real GSTINs are public
// records; the canonical anchor is TCS Gujarat 24AAACC4175D1Z4
// which hand-computes to terminal '4' under the standard
// factor 1,2,1,2,... pattern.

import { describe, it, expect } from "vitest";
import {
  validateGstin,
  gstinChecksumChar,
  gstinStateCode,
  gstinStateAbbr,
  isValidGstin,
  isValidGstinShape,
  panFromGstin,
  STATE_CODES,
} from "../api/_lib/gstin.js";

describe("gstinChecksumChar", () => {
  it("reproduces the canonical TCS Gujarat checksum", () => {
    expect(gstinChecksumChar("24AAACC4175D1Z")).toBe("4");
  });
  it("returns null on wrong length", () => {
    expect(gstinChecksumChar("SHORT")).toBeNull();
    expect(gstinChecksumChar("")).toBeNull();
    expect(gstinChecksumChar("24AAACC4175D1Z4EXTRA")).toBeNull();
  });
  it("returns null when a character is outside [0-9A-Z]", () => {
    expect(gstinChecksumChar("24aaacc4175d1z")).toBeNull();
    expect(gstinChecksumChar("24AAACC4175D-Z")).toBeNull();
  });
});

describe("isValidGstinShape", () => {
  it("accepts the canonical shape", () => {
    expect(isValidGstinShape("24AAACC4175D1Z4")).toBe(true);
    expect(isValidGstinShape("27AAPFU0939F1ZV")).toBe(true);
  });
  it("rejects wrong length / casing / structure", () => {
    expect(isValidGstinShape("")).toBe(false);
    expect(isValidGstinShape("24AAACC4175D1Z")).toBe(false); // 14
    expect(isValidGstinShape("24AAACC4175D1Z4X")).toBe(false); // 16
    expect(isValidGstinShape("24aaacc4175d1z4")).toBe(false); // lowercase
    expect(isValidGstinShape("AAAAACC4175D1Z4")).toBe(false); // first 2 alpha
    expect(isValidGstinShape("24AAACC4175D1Y4")).toBe(false); // pos 14 not Z
    expect(isValidGstinShape("24AAACC417AD1Z4")).toBe(false); // 4 digits required at PAN digit block
  });
  it("rejects non-string inputs", () => {
    expect(isValidGstinShape(null)).toBe(false);
    expect(isValidGstinShape(undefined)).toBe(false);
    expect(isValidGstinShape(123)).toBe(false);
    expect(isValidGstinShape({})).toBe(false);
  });
});

describe("validateGstin", () => {
  it("ok=true for known-real GSTINs", () => {
    expect(validateGstin("24AAACC4175D1Z4")).toEqual({
      ok: true,
      normalized: "24AAACC4175D1Z4",
    });
  });
  it("normalises whitespace and casing", () => {
    expect(validateGstin("  24aaacc4175d1z4  ")).toEqual({
      ok: true,
      normalized: "24AAACC4175D1Z4",
    });
  });
  it("rejects with INVALID_GSTIN_SHAPE on malformed input", () => {
    const r = validateGstin("BAD-GSTIN");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_GSTIN_SHAPE");
  });
  it("rejects with INVALID_GSTIN_STATE on a known-bad state code", () => {
    // 40 is not on CBIC's schedule. Construct an otherwise-valid
    // shape with state 40 and a fake checksum; the state check
    // must fire before the checksum check.
    const r = validateGstin("40AAACC4175D1ZX");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_GSTIN_STATE");
  });
  it("rejects with INVALID_GSTIN_CHECKSUM on a typo in the last char", () => {
    const r = validateGstin("24AAACC4175D1Z5");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_GSTIN_CHECKSUM");
  });
  it("rejects with INVALID_GSTIN_CHECKSUM on a digit-swap typo", () => {
    // Swap the 6th and 7th characters; shape still passes, state
    // still maps, but the checksum recomputes to something else.
    const r = validateGstin("24AAACR4175D1Z4");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_GSTIN_CHECKSUM");
  });
  it("treats null / undefined / empty as INVALID_GSTIN_SHAPE", () => {
    expect(validateGstin(null).code).toBe("INVALID_GSTIN_SHAPE");
    expect(validateGstin(undefined).code).toBe("INVALID_GSTIN_SHAPE");
    expect(validateGstin("").code).toBe("INVALID_GSTIN_SHAPE");
  });
});

describe("isValidGstin", () => {
  it("returns true for valid", () => {
    expect(isValidGstin("24AAACC4175D1Z4")).toBe(true);
  });
  it("returns false for invalid", () => {
    expect(isValidGstin("24AAACC4175D1Z5")).toBe(false);
    expect(isValidGstin("not a gstin")).toBe(false);
  });
});

describe("gstinStateCode / gstinStateAbbr", () => {
  it("returns the 2-digit code", () => {
    expect(gstinStateCode("24AAACC4175D1Z4")).toBe("24");
    expect(gstinStateCode("27AAPFU0939F1ZV")).toBe("27");
  });
  it("returns the state abbreviation", () => {
    expect(gstinStateAbbr("24AAACC4175D1Z4")).toBe("GJ"); // Gujarat
    expect(gstinStateAbbr("27AAPFU0939F1ZV")).toBe("MH"); // Maharashtra
  });
  it("returns null on bad shape", () => {
    expect(gstinStateCode("invalid")).toBeNull();
    expect(gstinStateAbbr("invalid")).toBeNull();
  });
});

// PAN-derived matching: the guard that stops an OCR-misread GSTIN from being
// treated as a brand-new customer (SO-upload matcher, so-intake.tsx Tier 1a).
describe("panFromGstin", () => {
  it("extracts the embedded 10-char PAN (chars 3-12)", () => {
    expect(panFromGstin("24AAACC4175D1Z4")).toBe("AAACC4175D");
  });
  it("is state-code and check-digit agnostic (misread state/check digit -> same PAN)", () => {
    // Same entity, OCR misread the 2-digit state code and the trailing digits.
    expect(panFromGstin("24AAACC4175D1Z4")).toBe(panFromGstin("29AAACC4175D2Z9"));
  });
  it("normalizes separators/case and returns null when too short", () => {
    expect(panFromGstin("24 aaacc4175d1z4")).toBe("AAACC4175D");
    expect(panFromGstin("24AAAC")).toBeNull();
    expect(panFromGstin(null)).toBeNull();
  });
});

describe("STATE_CODES table", () => {
  it("covers the 36 numbered states plus 97 (other territory) plus 99 (centre)", () => {
    // 01..38 plus 97 plus 99 = 40 codes total.
    expect(Object.keys(STATE_CODES).length).toBe(40);
    expect(STATE_CODES["27"]).toBe("MH");
    expect(STATE_CODES["29"]).toBe("KA");
    expect(STATE_CODES["97"]).toBe("OT");
  });
});
