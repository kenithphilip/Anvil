import { describe, it, expect } from "vitest";
import { normPart, parseParts, joinParts, bomPartSet, unknownParts } from "./spare-parts";

describe("parseParts / joinParts", () => {
  it("splits on newline or comma, trims, dedupes (case-insensitive), drops empties", () => {
    expect(parseParts("A-1\nB-2 ,  a-1 \n\n")).toEqual(["A-1", "B-2"]);
    expect(parseParts("")).toEqual([]);
    expect(parseParts(null)).toEqual([]);
  });
  it("joins back newline-separated (matchSpares format)", () => {
    expect(joinParts(["A-1", "B-2"])).toBe("A-1\nB-2");
    expect(joinParts([" A ", "", "B"])).toBe("A\nB");
  });
});

describe("bomPartSet / unknownParts", () => {
  const lines = [{ part_no: "GEAR-A" }, { part_no: "shank-1", supplier_part_no: "SUP-9" }];
  it("indexes part_no + supplier_part_no, normalized", () => {
    const s = bomPartSet(lines);
    expect(s.has("GEAR-A")).toBe(true);
    expect(s.has("SHANK-1")).toBe(true);   // uppercased
    expect(s.has("SUP-9")).toBe(true);
  });
  it("flags only parts NOT in the BOM", () => {
    const s = bomPartSet(lines);
    expect(unknownParts(["gear-a", "TYPO-X"], s)).toEqual(["TYPO-X"]);
  });
  it("flags nothing when the BOM set is empty (avoid false alarms)", () => {
    expect(unknownParts(["ANY"], new Set())).toEqual([]);
  });
  it("normPart uppercases + trims", () => {
    expect(normPart("  x-1 ")).toBe("X-1");
  });
});
