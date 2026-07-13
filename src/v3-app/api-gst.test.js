// Unit tests for src/api/_lib/gst.js — the shared GST resolver (rate
// resolution, place of supply, CGST/SGST/UTGST/IGST split). Includes a parity
// check proving splitTax reproduces the old inline tally-build-voucher math.

import { describe, it, expect } from "vitest";
import { resolveGstRate, placeOfSupply, splitTax, isUnionTerritory } from "../api/_lib/gst.js";

describe("resolveGstRate", () => {
  it("line-stated rate always wins", () => {
    expect(resolveGstRate({ line: { gst_pct: 12 }, item: { rate_of_duty_pct: 18 } }))
      .toEqual({ rate: 12, source: "line" });
  });
  it("falls back to the item-master rate when the PO stated none (the no-GST-PO fix)", () => {
    expect(resolveGstRate({ line: {}, item: { rate_of_duty_pct: 18 } }))
      .toEqual({ rate: 18, source: "item_master" });
  });
  it("exempt / nil / non-GST classification resolves to 0", () => {
    expect(resolveGstRate({ line: {}, item: { taxability_type: "EXEMPT", rate_of_duty_pct: 18 } }))
      .toEqual({ rate: 0, source: "exempt" });
    expect(resolveGstRate({ line: {}, item: { taxability_type: "NIL_RATED" } }).rate).toBe(0);
  });
  it("returns null/unresolved when neither the line nor the master has a rate (caller must flag)", () => {
    expect(resolveGstRate({ line: {}, item: { rate_of_duty_pct: null } })).toEqual({ rate: null, source: null });
    expect(resolveGstRate({ line: {}, item: null })).toEqual({ rate: null, source: null });
  });
  it("a zero line rate is a real 0, not unresolved", () => {
    expect(resolveGstRate({ line: { gst_pct: 0 }, item: { rate_of_duty_pct: 18 } }))
      .toEqual({ rate: 0, source: "line" });
  });
});

describe("placeOfSupply", () => {
  it("same state -> intrastate", () => {
    expect(placeOfSupply("27", "27")).toBe("intrastate");
    expect(placeOfSupply("7", "07")).toBe("intrastate"); // pad tolerance
  });
  it("different state -> interstate", () => {
    expect(placeOfSupply("27", "29")).toBe("interstate");
  });
  it("unknown either side -> interstate (conservative)", () => {
    expect(placeOfSupply(null, "27")).toBe("interstate");
    expect(placeOfSupply("27", "")).toBe("interstate");
  });
});

describe("splitTax", () => {
  it("intrastate splits the rate into equal CGST + SGST", () => {
    expect(splitTax(1000, 18, "intrastate")).toEqual({ cgst: 90, sgst: 90, utgst: 0, igst: 0 });
  });
  it("interstate puts the full rate into IGST", () => {
    expect(splitTax(1000, 18, "interstate")).toEqual({ cgst: 0, sgst: 0, utgst: 0, igst: 180 });
  });
  it("intra-UT supply uses CGST + UTGST instead of SGST", () => {
    expect(splitTax(1000, 18, "intrastate", { unionTerritory: true }))
      .toEqual({ cgst: 90, sgst: 0, utgst: 90, igst: 0 });
  });
  it("zero rate or zero taxable -> all zero", () => {
    expect(splitTax(0, 18, "intrastate")).toEqual({ cgst: 0, sgst: 0, utgst: 0, igst: 0 });
    expect(splitTax(1000, 0, "interstate")).toEqual({ cgst: 0, sgst: 0, utgst: 0, igst: 0 });
  });

  // Parity: reproduce the exact old inline math from tally-build-voucher.js.
  it("matches the legacy inline split for a range of inputs", () => {
    const round2 = (n) => Math.round(n * 100) / 100;
    for (const [taxable, pct] of [[57180, 18], [12345.67, 12], [999.99, 5], [250000, 28]]) {
      const intra = splitTax(taxable, pct, "intrastate");
      const inter = splitTax(taxable, pct, "interstate");
      expect(intra.cgst).toBe(round2((taxable * pct) / 200));
      expect(intra.sgst).toBe(round2((taxable * pct) / 200));
      expect(inter.igst).toBe(round2((taxable * pct) / 100));
    }
  });
});

describe("isUnionTerritory", () => {
  it("flags UTGST territories but not legislature states (Delhi/Puducherry/J&K)", () => {
    expect(isUnionTerritory("04")).toBe(true);   // Chandigarh
    expect(isUnionTerritory("38")).toBe(true);   // Ladakh
    expect(isUnionTerritory("07")).toBe(false);  // Delhi -> SGST
    expect(isUnionTerritory("34")).toBe(false);  // Puducherry -> SGST
    expect(isUnionTerritory("27")).toBe(false);  // Maharashtra
  });
});
