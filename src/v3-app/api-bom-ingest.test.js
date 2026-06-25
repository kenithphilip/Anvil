// Unit tests for the pure BOM derivation helpers (_lib/bom-ingest.js):
// level->edge walk, modification diff, assembly detection, item
// candidates. No I/O.

import { describe, it, expect } from "vitest";
import { deriveStructure, computeDiff, itemCandidates } from "../api/_lib/bom-ingest.js";

describe("deriveStructure", () => {
  it("flat BOM (no levels): every part is a direct child of the asset root", () => {
    const lines = [
      { seq_no: 1, part_no: "A", qty: 2 },
      { seq_no: 2, part_no: "B", qty: 1 },
    ];
    const { edges, assemblies } = deriveStructure("GUN-1", lines);
    expect(edges).toEqual([
      { parent_part_no: "GUN-1", child_part_no: "A", qty: 2, uom: null },
      { parent_part_no: "GUN-1", child_part_no: "B", qty: 1, uom: null },
    ]);
    expect(assemblies.size).toBe(0);
  });

  it("multi-level BOM: parent is the nearest prior line one level up", () => {
    const lines = [
      { seq_no: 1, level: 1, part_no: "TOP", qty: 1 },
      { seq_no: 2, level: 2, part_no: "SUB", qty: 2 },
      { seq_no: 3, level: 3, part_no: "LEAF", qty: 4 },
      { seq_no: 4, level: 2, part_no: "SUB2", qty: 1 },
    ];
    const { edges, assemblies, parentIndex } = deriveStructure("GUN-1", lines);
    expect(edges).toContainEqual({ parent_part_no: "GUN-1", child_part_no: "TOP", qty: 1, uom: null });
    expect(edges).toContainEqual({ parent_part_no: "TOP", child_part_no: "SUB", qty: 2, uom: null });
    expect(edges).toContainEqual({ parent_part_no: "SUB", child_part_no: "LEAF", qty: 4, uom: null });
    expect(edges).toContainEqual({ parent_part_no: "TOP", child_part_no: "SUB2", qty: 1, uom: null });
    expect([...assemblies].sort()).toEqual(["SUB", "TOP"]);
    // LEAF (index 2) parent is SUB (index 1)
    expect(parentIndex.get(2)).toBe(1);
    // TOP (index 0) parent is root
    expect(parentIndex.get(0)).toBe(-1);
  });

  it("collapses duplicate parent->child edges by summing qty", () => {
    const lines = [
      { seq_no: 1, part_no: "BOLT", qty: 4 },
      { seq_no: 2, part_no: "BOLT", qty: 6 },
    ];
    const { edges } = deriveStructure("ASSY", lines);
    expect(edges).toEqual([{ parent_part_no: "ASSY", child_part_no: "BOLT", qty: 10, uom: null }]);
  });

  it("sorts by seq_no regardless of input order; non-positive qty defaults to 1", () => {
    const lines = [
      { seq_no: 2, part_no: "B", qty: 0 },
      { seq_no: 1, part_no: "A" },
    ];
    const { edges } = deriveStructure("X", lines);
    expect(edges.map((e) => e.child_part_no)).toEqual(["A", "B"]);
    expect(edges.every((e) => e.qty === 1)).toBe(true);
  });

  it("a deeper line whose intermediate level is missing falls back to root", () => {
    const lines = [
      { seq_no: 1, level: 1, part_no: "TOP" },
      { seq_no: 2, level: 3, part_no: "ORPHAN" }, // no level-2 ancestor
    ];
    const { edges } = deriveStructure("ROOT", lines);
    expect(edges).toContainEqual({ parent_part_no: "ROOT", child_part_no: "ORPHAN", qty: 1, uom: null });
  });
});

describe("computeDiff", () => {
  const existing = [
    { part_no: "A", qty: 1, material: "EN8" },
    { part_no: "B", qty: 2 },
    { part_no: "C", qty: 1 },
  ];
  it("classifies added / removed / changed / unchanged by part_no", () => {
    const incoming = [
      { part_no: "A", qty: 1, material: "EN8" }, // unchanged
      { part_no: "B", qty: 5 },                  // changed (qty)
      { part_no: "D", qty: 1 },                  // added
      // C removed
    ];
    const d = computeDiff(existing, incoming);
    expect(d.added).toEqual(["D"]);
    expect(d.removed).toEqual(["C"]);
    expect(d.changed).toEqual(["B"]);
    expect(d.unchanged).toEqual(["A"]);
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
  });
  it("identical re-import reports all unchanged", () => {
    const d = computeDiff(existing, existing);
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 3 });
  });
});

describe("itemCandidates", () => {
  it("dedups by part_no, flags assemblies, marks data_source imported", () => {
    const lines = [
      { part_no: "TOP", part_name: "Top assy", uom: "EA" },
      { part_no: "LEAF", part_name: "Leaf", material: "CuCrZr" },
      { part_no: "LEAF", part_name: "dup" },
    ];
    const out = itemCandidates(lines, new Set(["TOP"]), "O-CHINA");
    expect(out).toHaveLength(2);
    const top = out.find((x) => x.part_no === "TOP");
    expect(top).toMatchObject({ is_assembly: true, source_country: "O-CHINA", data_source: "imported", description: "Top assy" });
    const leaf = out.find((x) => x.part_no === "LEAF");
    expect(leaf).toMatchObject({ is_assembly: false, material: "CuCrZr" });
  });
  it("falls back to part_no for a blank description", () => {
    const out = itemCandidates([{ part_no: "X" }], new Set(), null);
    expect(out[0].description).toBe("X");
  });
});
