// CM PDM P1b: mapping a DocAI assembly_bom extraction to the /api/bom/import
// { asset, lines } contract. Pure translation — the field traps (partNumber ->
// part_no, title_block.asset_code null -> drawing_no fallback, balloon rows
// with no part number, declared-vs-importable shortfall) are the whole point.

import { describe, it, expect } from "vitest";
import { mapAssemblyBomToImport } from "../api/_lib/assembly-bom-to-import.js";

const NORM = {
  classification: "assembly_bom",
  customer: null,
  title_block: { drawing_no: "GA-1234", revision: "B", asset_code: "GUN-77", title: "Weld Gun", material: null, sheet: "1 of 2", scale: "1:2" },
  lines: [
    { balloon_no: "1", partNumber: "SHANK-A", description: "Shank", quantity: 2, material: "EN8", is_spare: true },
    { balloon_no: "2", partNumber: "TIP-9", description: "Electrode tip", quantity: 4, material: "CuCrZr", is_spare: false },
  ],
  stated_line_count: 5,
};

describe("mapAssemblyBomToImport — asset header", () => {
  it("uses the title block's asset_code as the BOM root + title as name", () => {
    const { asset } = mapAssemblyBomToImport(NORM);
    expect(asset.asset_code).toBe("GUN-77");
    expect(asset.name).toBe("Weld Gun");
    expect(asset.revision).toBe("B");
    expect(asset.drawing_no).toBe("GA-1234");
    expect(asset.source_format).toBe("assembly_drawing");
    expect(asset.metadata).toMatchObject({ extracted_from: "assembly_drawing", sheet: "1 of 2", scale: "1:2" });
  });

  it("falls back to drawing_no when the title block has no asset_code", () => {
    const n = { ...NORM, title_block: { ...NORM.title_block, asset_code: null } };
    expect(mapAssemblyBomToImport(n).asset.asset_code).toBe("GA-1234");
  });

  it("lets an operator override the asset_code + revision", () => {
    const { asset } = mapAssemblyBomToImport(NORM, { asset_code: "GUN-77-A", revision: "C", customer_id: "cust-1" });
    expect(asset.asset_code).toBe("GUN-77-A");
    expect(asset.revision).toBe("C");
    expect(asset.customer_id).toBe("cust-1");
  });

  it("defaults revision to '' (a blank revision is one asset, not a fork)", () => {
    const n = { ...NORM, title_block: { ...NORM.title_block, revision: null } };
    expect(mapAssemblyBomToImport(n).asset.revision).toBe("");
  });

  it("leaves asset_code empty when neither asset_code nor drawing_no exist", () => {
    const n = { ...NORM, title_block: { title: "x" } };
    const out = mapAssemblyBomToImport(n);
    expect(out.asset.asset_code).toBe("");
    expect(out.warnings.map((w) => w.code)).toContain("missing_asset_code");
  });
});

describe("mapAssemblyBomToImport — lines", () => {
  it("maps camelCase partNumber/quantity to part_no/qty and carries balloon_no + is_spare", () => {
    const { lines } = mapAssemblyBomToImport(NORM);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ part_no: "SHANK-A", part_name: "Shank", qty: 2, material: "EN8", is_spare: true, balloon_no: "1", level: 1 });
    expect(lines[1]).toMatchObject({ part_no: "TIP-9", qty: 4, is_spare: false, balloon_no: "2" });
  });

  it("keeps (does not drop) rows without a part number but reports them", () => {
    const n = {
      ...NORM,
      lines: [
        { balloon_no: "1", partNumber: "SHANK-A", quantity: 2 },
        { balloon_no: "2", partNumber: null, description: "unreadable", quantity: 1 },
      ],
    };
    const out = mapAssemblyBomToImport(n);
    expect(out.lines).toHaveLength(2);           // unfiltered — importBom drops the null-part row
    expect(out.meta.importable_line_count).toBe(1);
    expect(out.meta.dropped_no_part_no).toBe(1);
    expect(out.warnings.map((w) => w.code)).toContain("lines_without_part_no");
  });
});

describe("mapAssemblyBomToImport — completeness warnings", () => {
  it("flags a declared/importable shortfall (the drawing's own count vs what mapped)", () => {
    const out = mapAssemblyBomToImport(NORM); // stated 5, importable 2
    const w = out.warnings.find((x) => x.code === "line_count_shortfall");
    expect(w).toMatchObject({ declared: 5, importable: 2 });
  });

  it("does not flag a shortfall when importable meets the declared count", () => {
    const n = { ...NORM, stated_line_count: 2 };
    expect(mapAssemblyBomToImport(n).warnings.map((w) => w.code)).not.toContain("line_count_shortfall");
  });

  it("flags a non-assembly classification", () => {
    const n = { classification: "non_drawing", title_block: null, lines: [], stated_line_count: null };
    const out = mapAssemblyBomToImport(n);
    expect(out.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["not_assembly_bom", "no_importable_lines"]));
    expect(out.lines).toEqual([]);
  });

  it("handles null / empty normalized input without throwing", () => {
    const out = mapAssemblyBomToImport(null);
    expect(out.asset.asset_code).toBe("");
    expect(out.lines).toEqual([]);
    expect(out.meta.importable_line_count).toBe(0);
  });
});
