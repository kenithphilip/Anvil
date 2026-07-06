import { describe, it, expect } from "vitest";
import {
  matchSpares,
  nameIsCleanMatch,
  nameMatchCandidates,
  isCopperMaterial,
  isConsumableCol,
  stripVariant,
} from "./spare-match";

describe("nameIsCleanMatch", () => {
  it("matches keyword at a word boundary with spec-only remainder", () => {
    expect(nameIsCleanMatch("SHUNT 120MM", "SHUNT")).toBe(true);
    expect(nameIsCleanMatch("SHUNT", "SHUNT")).toBe(true);
    expect(nameIsCleanMatch("SHUNT-L", "SHUNT")).toBe(true);
  });
  it("rejects when the remainder is a real word (different part)", () => {
    expect(nameIsCleanMatch("SHUNT COVER", "SHUNT")).toBe(false);
  });
  it("rejects a different leading word", () => {
    expect(nameIsCleanMatch("COVER SHUNT", "SHUNT")).toBe(false);
  });
});

describe("nameMatchCandidates", () => {
  it("strips a leading CJK prefix so the Latin name matches", () => {
    const cands = nameMatchCandidates("分流器SHUNT 80");
    expect(cands.some((c) => nameIsCleanMatch(c, "SHUNT"))).toBe(true);
  });
  it("strips leading numbering then CJK", () => {
    const cands = nameMatchCandidates("1.电极ELECTRODE");
    expect(cands.some((c) => nameIsCleanMatch(c, "ELECTRODE"))).toBe(true);
  });
});

describe("isCopperMaterial", () => {
  it("recognizes common copper alloys", () => {
    ["CuCrZr", "CRCU", "CR-CU", "C1100", "BE14C", "Chromium Copper", "copper"].forEach((m) =>
      expect(isCopperMaterial(m)).toBe(true)
    );
  });
  it("rejects non-copper materials and blanks", () => {
    expect(isCopperMaterial("SS304")).toBe(false);
    expect(isCopperMaterial("")).toBe(false);
    expect(isCopperMaterial(null)).toBe(false);
  });
});

describe("isConsumableCol", () => {
  it("flags consumable preset columns", () => {
    expect(isConsumableCol("TIP")).toBe(true);
    expect(isConsumableCol("ELECTRODE")).toBe(true);
  });
  it("does not flag spare/hardware columns", () => {
    expect(isConsumableCol("ARM")).toBe(false);
    expect(isConsumableCol("BOLT")).toBe(false);
  });
});

describe("matchSpares", () => {
  const bom = [
    { part_no: "T-13", part_name: "TIP 13", material: "CuCrZr", size: "13" },
    { part_no: "T-16-A", part_name: "电极TIP CAP", material: "CRCU", size: "16" },
    { part_no: "SS-COVER", part_name: "TIP COVER", material: "SS304", size: "" },
    { part_no: "SHN-1", part_name: "SHUNT 120", material: "Copper", size: "120" },
    { part_no: "SHA-1", part_name: "SHUNT ASSY", material: "Copper", size: "" },
    { part_no: "GB/T 70-85 M6", part_name: "BOLT M6", material: "Steel", size: "M6" },
    { part_no: "ARM-1", part_name: "ARM 200", material: "Alu", size: "200" },
    { part_no: "ARMA-1", part_name: "ARM ASSY", material: "Alu", size: "" },
  ];

  it("matches a consumable column by name and copper filter", () => {
    const r = matchSpares(bom, ["TIP"]);
    // T-13 matches name TIP (copper); SS-COVER excluded (not clean + not copper)
    expect(r["TIP"].split("\n")).toContain("T-13");
    expect(r["TIP"]).not.toContain("SS-COVER");
  });

  it("matches part-number patterns (BOLT via GB/T 70-85)", () => {
    const r = matchSpares(bom, ["BOLT"]);
    expect(r["BOLT"].split("\n")).toContain("GB/T 70-85 M6");
  });

  it("excludes the more-specific assembly from the broad column", () => {
    const r = matchSpares(bom, ["SHUNT", "ARM"]);
    expect(r["SHUNT"].split("\n")).toContain("SHN-1");
    expect(r["SHUNT"]).not.toContain("SHA-1");
    expect(r["ARM"].split("\n")).toContain("ARM-1");
    expect(r["ARM"]).not.toContain("ARMA-1");
  });

  it("dedups by part_no and returns newline-joined part numbers", () => {
    const dup = [
      { part_no: "T-1", part_name: "TIP 1", material: "Copper", size: "1" },
      { part_no: "T-1", part_name: "TIP 1", material: "Copper", size: "1" },
    ];
    expect(matchSpares(dup, ["TIP"])["TIP"]).toBe("T-1");
  });
});

describe("stripVariant + MOVING/FIXED columns (PR3)", () => {
  it("strips moving/fixed qualifiers to the base category", () => {
    expect(stripVariant("SHANK (MOVING)")).toBe("SHANK");
    expect(stripVariant("TIP BASE (FIXED)")).toBe("TIP BASE");
    expect(stripVariant("ADAPTER - MOVING")).toBe("ADAPTER");
    expect(stripVariant("HOLDER")).toBe("HOLDER"); // unqualified unchanged
  });

  it("treats a moving/fixed consumable variant as consumable", () => {
    expect(isConsumableCol("SHANK (MOVING)")).toBe(true);
    expect(isConsumableCol("TIP BASE (FIXED)")).toBe(true);
    expect(isConsumableCol("GEAR CASE ASSY")).toBe(false); // spare, not consumable
  });

  it("auto-fills both variants from the base part name, keeping the copper filter", () => {
    const bom = [
      { part_no: "TWS-092-100-3", part_name: "SHANK 100", material: "CuCrZr", size: "100" },
      { part_no: "SS-SHANK", part_name: "SHANK 90", material: "SS304", size: "90" }, // non-copper
    ];
    const r = matchSpares(bom, ["SHANK (MOVING)", "SHANK (FIXED)"]);
    expect(r["SHANK (MOVING)"].split("\n")).toContain("TWS-092-100-3");
    expect(r["SHANK (FIXED)"].split("\n")).toContain("TWS-092-100-3");
    // Consumable copper filter still applies to the variant column.
    expect(r["SHANK (MOVING)"]).not.toContain("SS-SHANK");
  });
});
