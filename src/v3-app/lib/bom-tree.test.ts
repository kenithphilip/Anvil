import { describe, it, expect } from "vitest";
import { buildBomNodes, isHierarchicalBom, collapsedAssemblies, visibleBomNodes } from "./bom-tree";

// A gun BOM: gun (1) → GEAR CASE ASSY (2) → its parts (3), then a flat part (1).
const LINES = [
  { part_no: "GUN-12", level: 1 },        // 0 top
  { part_no: "GEAR-CASE-ASSY", level: 2 },// 1 sub-assembly
  { part_no: "GEAR-A", level: 3 },        // 2 child of gear case
  { part_no: "GEAR-B", level: 3 },        // 3 child of gear case
  { part_no: "SHANK", level: 1 },         // 4 top-level part
];

describe("buildBomNodes / hasChildren", () => {
  it("marks a line as an assembly when the next line is deeper", () => {
    const n = buildBomNodes(LINES);
    expect(n[0].hasChildren).toBe(true);   // GUN → GEAR CASE
    expect(n[1].hasChildren).toBe(true);   // GEAR CASE → GEAR-A/B
    expect(n[2].hasChildren).toBe(false);  // GEAR-A leaf
    expect(n[4].hasChildren).toBe(false);  // SHANK leaf
    expect(n.map((x) => x.level)).toEqual([1, 2, 3, 3, 1]);
  });
  it("treats null/0 levels as flat (1) with no children", () => {
    const n = buildBomNodes([{ part_no: "A" }, { part_no: "B", level: 0 }]);
    expect(isHierarchicalBom(n)).toBe(false);
    expect(n.every((x) => x.level === 1)).toBe(true);
  });
});

describe("visibleBomNodes (collapse/expand)", () => {
  const nodes = buildBomNodes(LINES);

  it("fully collapsed shows only top-level lines (drill-in start)", () => {
    const collapsed = collapsedAssemblies(nodes);   // GUN + GEAR CASE collapsed
    // GUN collapsed hides everything under it (levels 2 & 3); SHANK stays.
    expect(visibleBomNodes(nodes, collapsed).map((n) => n.line.part_no)).toEqual(["GUN-12", "SHANK"]);
  });

  it("expanding the gun reveals its sub-assembly (still collapsed)", () => {
    const collapsed = new Set<number>([1]);  // only GEAR CASE collapsed
    expect(visibleBomNodes(nodes, collapsed).map((n) => n.line.part_no)).toEqual(["GUN-12", "GEAR-CASE-ASSY", "SHANK"]);
  });

  it("expanding the gear-case-assy opens its subcomponents", () => {
    const collapsed = new Set<number>();     // nothing collapsed = fully expanded
    expect(visibleBomNodes(nodes, collapsed).map((n) => n.line.part_no)).toEqual(["GUN-12", "GEAR-CASE-ASSY", "GEAR-A", "GEAR-B", "SHANK"]);
  });

  it("a collapsed ancestor hides nested assemblies too", () => {
    const deep = buildBomNodes([
      { part_no: "TOP", level: 1 }, { part_no: "MID", level: 2 }, { part_no: "LEAF", level: 3 }, { part_no: "NEXT", level: 1 },
    ]);
    expect(visibleBomNodes(deep, new Set([0])).map((n) => n.line.part_no)).toEqual(["TOP", "NEXT"]);
  });
});
