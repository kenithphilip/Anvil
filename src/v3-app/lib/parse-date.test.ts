// Unit tests for the permissive PO-date normaliser.
//
// The exact failure that prompted this helper: the extractor
// returned "29/04/2026" (Indian DD/MM/YYYY), the order create
// posted it verbatim, Postgres rejected with "date/time field
// value out of range".

import { describe, it, expect } from "vitest";
import { parsePoDate, hintForCountry } from "./parse-date";

describe("parsePoDate", () => {
  it("returns ISO YYYY-MM-DD unchanged", () => {
    expect(parsePoDate("2026-04-29")).toBe("2026-04-29");
  });
  it("trims ISO timestamps to date only", () => {
    expect(parsePoDate("2026-04-29T10:34:01Z")).toBe("2026-04-29");
  });
  it("converts DD/MM/YYYY (Indian default)", () => {
    expect(parsePoDate("29/04/2026")).toBe("2026-04-29");
    expect(parsePoDate("01/01/2026")).toBe("2026-01-01");
  });
  it("converts DD-MM-YYYY", () => {
    expect(parsePoDate("29-04-2026")).toBe("2026-04-29");
  });
  it("converts DD.MM.YYYY", () => {
    expect(parsePoDate("29.04.2026")).toBe("2026-04-29");
  });
  it("converts 2-digit year as 20YY", () => {
    expect(parsePoDate("29/04/26")).toBe("2026-04-29");
    expect(parsePoDate("01/01/00")).toBe("2000-01-01");
  });
  it("falls back to MM/DD interpretation when first field > 12 is impossible", () => {
    // 31/04 is impossible in any locale; the algorithm tries
    // both arrangements. 31 cannot be a month so the day-major
    // arrangement is the only viable one. The result would be
    // April 31 which is invalid; expect null.
    expect(parsePoDate("31/04/2026")).toBeNull();
  });
  it("accepts US-style MM/DD/YYYY when day is unambiguously > 12", () => {
    // a=4 b=29 y=2026: a<=12 b>12 -> swap to day=29 mon=4
    expect(parsePoDate("4/29/2026")).toBe("2026-04-29");
  });
  it("returns null for empty / null / undefined", () => {
    expect(parsePoDate("")).toBeNull();
    expect(parsePoDate(null)).toBeNull();
    expect(parsePoDate(undefined)).toBeNull();
  });
  it("returns null for garbage strings", () => {
    expect(parsePoDate("not a date")).toBeNull();
    expect(parsePoDate("xxxx/xx/xxxx")).toBeNull();
  });
  it("rejects invalid calendar dates", () => {
    expect(parsePoDate("31/02/2026")).toBeNull(); // Feb 31
    expect(parsePoDate("32/01/2026")).toBeNull(); // day out of range
    expect(parsePoDate("00/01/2026")).toBeNull();
  });
  it("handles whitespace", () => {
    expect(parsePoDate("  29/04/2026  ")).toBe("2026-04-29");
  });

  it("treats YYYY/MM/DD as year-first regardless of hint", () => {
    expect(parsePoDate("2026/04/29")).toBe("2026-04-29");
    expect(parsePoDate("2026/04/29", { country: "US" })).toBe("2026-04-29");
    expect(parsePoDate("2026/04/29", { hint: "MDY" })).toBe("2026-04-29");
  });
});

describe("parsePoDate locale-aware", () => {
  it("US (MDY) reads 04/12/2026 as April 12", () => {
    expect(parsePoDate("04/12/2026", { country: "US" })).toBe("2026-04-12");
  });
  it("IN (DMY) reads 04/12/2026 as 4 December", () => {
    expect(parsePoDate("04/12/2026", { country: "IN" })).toBe("2026-12-04");
  });
  it("DE (DMY) decodes 29.04.2026", () => {
    expect(parsePoDate("29.04.2026", { country: "DE" })).toBe("2026-04-29");
  });
  it("JP (YMD) accepts 2026/04/29", () => {
    expect(parsePoDate("2026/04/29", { country: "JP" })).toBe("2026-04-29");
  });
  it("explicit hint overrides country", () => {
    expect(parsePoDate("04/12/2026", { country: "US", hint: "DMY" })).toBe("2026-12-04");
    expect(parsePoDate("04/12/2026", { country: "IN", hint: "MDY" })).toBe("2026-04-12");
  });
  it("unambiguous dates ignore the hint (29 cannot be a month)", () => {
    expect(parsePoDate("29/04/2026", { country: "US" })).toBe("2026-04-29");
    expect(parsePoDate("4/29/2026", { country: "IN" })).toBe("2026-04-29");
  });
  it("unknown country falls back to DMY", () => {
    expect(parsePoDate("04/12/2026", { country: "XX" })).toBe("2026-12-04");
  });
  it("no country and no hint defaults to DMY", () => {
    expect(parsePoDate("04/12/2026")).toBe("2026-12-04");
  });
});

describe("hintForCountry", () => {
  it("returns MDY for US + CA", () => {
    expect(hintForCountry("US")).toBe("MDY");
    expect(hintForCountry("CA")).toBe("MDY");
  });
  it("returns YMD for JP / KR / CN / TW / HK", () => {
    expect(hintForCountry("JP")).toBe("YMD");
    expect(hintForCountry("KR")).toBe("YMD");
    expect(hintForCountry("CN")).toBe("YMD");
    expect(hintForCountry("TW")).toBe("YMD");
    expect(hintForCountry("HK")).toBe("YMD");
  });
  it("returns DMY for IN / GB / DE / FR / AU / NZ", () => {
    ["IN", "GB", "DE", "FR", "AU", "NZ"].forEach((c) => {
      expect(hintForCountry(c)).toBe("DMY");
    });
  });
  it("returns null for unknown or empty", () => {
    expect(hintForCountry("XX")).toBeNull();
    expect(hintForCountry("")).toBeNull();
    expect(hintForCountry(null)).toBeNull();
  });
  it("is case-insensitive and tolerates extra chars", () => {
    expect(hintForCountry("us")).toBe("MDY");
    expect(hintForCountry("USA")).toBe("MDY");
    expect(hintForCountry(" jp ")).toBe("YMD");
  });
});
