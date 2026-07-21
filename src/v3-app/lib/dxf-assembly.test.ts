// PDM P2: deterministic DXF assembly-BOM extraction. DXF is already structured,
// so this reads the title block + parts list WITHOUT an LLM. Tests cover the two
// real CAD shapes (attribute-block BOM rows, free-text grid) + the guards that
// stop random geometry becoming a fake parts list.

import { describe, it, expect } from "vitest";
import { parseDxfEntities, extractAssemblyFromDxf } from "./dxf-assembly";

// Build a DXF group-code stream from (code, value) pairs.
const dxf = (pairs: Array<[number | string, string]>) => pairs.map(([c, v]) => c + "\n" + v).join("\n");

const insert = (block: string, attribs: Array<[string, string]>) => {
  const out: Array<[number | string, string]> = [[0, "INSERT"], [2, block], [10, "100"], [20, "50"], [66, "1"]];
  for (const [tag, value] of attribs) out.push([0, "ATTRIB"], [2, tag], [1, value], [10, "100"], [20, "50"]);
  out.push([0, "SEQEND"], [5, "0"]);
  return out;
};

const ATTR_DXF = dxf([
  [0, "SECTION"], [2, "ENTITIES"],
  ...insert("TITLEBLOCK", [["DWG_NO", "GA-1234"], ["REV", "B"], ["TITLE", "WELD GUN ASSY"], ["MATERIAL", "-"], ["SCALE", "1:2"]]),
  ...insert("BOMROW", [["ITEM", "1"], ["PART_NO", "SHANK-A"], ["DESC", "Shank"], ["QTY", "2"], ["MATERIAL", "EN8"]]),
  ...insert("BOMROW", [["ITEM", "2"], ["PART_NO", "TIP-9"], ["DESC", "Electrode tip"], ["QTY", "4"], ["MATERIAL", "CuCrZr"], ["SPARE", "Y"]]),
  [0, "ENDSEC"], [0, "EOF"],
]);

describe("parseDxfEntities", () => {
  it("reads INSERTs with their ATTRIB children + TEXT positions", () => {
    const ents = parseDxfEntities(ATTR_DXF);
    const inserts = ents.filter((e) => e.type === "INSERT") as any[];
    expect(inserts).toHaveLength(3);
    expect(inserts[0].block).toBe("TITLEBLOCK");
    expect(inserts[0].attribs.find((a: any) => a.tag === "DWG_NO").value).toBe("GA-1234");
    expect(inserts[1].attribs).toHaveLength(5);
  });

  it("cleans MTEXT inline formatting", () => {
    const d = dxf([[0, "MTEXT"], [1, "{\\fArial|b1;WELD}\\PGUN"], [10, "0"], [20, "0"]]);
    const ents = parseDxfEntities(d) as any[];
    expect(ents[0].type).toBe("MTEXT");
    expect(ents[0].text).toBe("WELD GUN");
  });

  it("survives a malformed / empty file without throwing", () => {
    expect(parseDxfEntities("")).toEqual([]);
    expect(parseDxfEntities("garbage\nlines\nno codes")).toBeInstanceOf(Array);
  });
});

describe("extractAssemblyFromDxf — attribute-block BOM (clean path)", () => {
  const out = extractAssemblyFromDxf(ATTR_DXF);

  it("pulls the title block into the asset header", () => {
    expect(out.asset).toMatchObject({ asset_code: "GA-1234", name: "WELD GUN ASSY", revision: "B", drawing_no: "GA-1234", source_format: "assembly_dxf" });
  });

  it("reads every BOM row from the attribute blocks", () => {
    expect(out.meta.method).toBe("attribute_blocks");
    expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ balloon_no: "1", part_no: "SHANK-A", part_name: "Shank", qty: 2, material: "EN8" });
    expect(out.lines[1]).toMatchObject({ part_no: "TIP-9", qty: 4, is_spare: true });
  });

  it("does not turn the title block into a phantom BOM row", () => {
    expect(out.lines.some((l) => l.part_no === "GA-1234")).toBe(false);
    expect(out.meta.importable_line_count).toBe(2);
  });

  it("falls back to drawing_no for the asset root + honours an override", () => {
    const noAssetTag = extractAssemblyFromDxf(ATTR_DXF);
    expect(noAssetTag.asset.asset_code).toBe("GA-1234"); // from drawing_no
    const overridden = extractAssemblyFromDxf(ATTR_DXF, { asset_code: "GUN-77", revision: "C" });
    expect(overridden.asset).toMatchObject({ asset_code: "GUN-77", revision: "C" });
  });
});

describe("extractAssemblyFromDxf — free-text grid (fallback path)", () => {
  // A parts list drawn as plain TEXT with a header row, no attribute blocks.
  const grid = dxf([
    [0, "SECTION"], [2, "ENTITIES"],
    // header row (y=100)
    [0, "TEXT"], [1, "ITEM"], [10, "10"], [20, "100"],
    [0, "TEXT"], [1, "PART NO"], [10, "30"], [20, "100"],
    [0, "TEXT"], [1, "DESC"], [10, "60"], [20, "100"],
    [0, "TEXT"], [1, "QTY"], [10, "90"], [20, "100"],
    // row 1 (y=90)
    [0, "TEXT"], [1, "1"], [10, "10"], [20, "90"],
    [0, "TEXT"], [1, "BASE-PLATE"], [10, "30"], [20, "90"],
    [0, "TEXT"], [1, "Base plate"], [10, "60"], [20, "90"],
    [0, "TEXT"], [1, "1"], [10, "90"], [20, "90"],
    // row 2 (y=80)
    [0, "TEXT"], [1, "2"], [10, "10"], [20, "80"],
    [0, "TEXT"], [1, "PIN-5"], [10, "30"], [20, "80"],
    [0, "TEXT"], [1, "Dowel pin"], [10, "60"], [20, "80"],
    [0, "TEXT"], [1, "4"], [10, "90"], [20, "80"],
    [0, "ENDSEC"], [0, "EOF"],
  ]);

  it("recovers rows from a labelled text grid, flagged low-confidence", () => {
    const out = extractAssemblyFromDxf(grid);
    expect(out.meta.method).toBe("text_grid");
    expect(out.confidence).toBeLessThan(0.7);
    expect(out.lines.map((l) => l.part_no)).toEqual(["BASE-PLATE", "PIN-5"]);
    expect(out.lines[1].qty).toBe(4);
    expect(out.warnings.map((w) => w.code)).toContain("parts_list_heuristic");
  });
});

describe("extractAssemblyFromDxf — guards", () => {
  it("returns no rows + a warning when there is no parts list", () => {
    const noBom = dxf([[0, "SECTION"], [2, "ENTITIES"], [0, "TEXT"], [1, "SOME NOTE"], [10, "5"], [20, "5"], [0, "ENDSEC"], [0, "EOF"]]);
    const out = extractAssemblyFromDxf(noBom);
    expect(out.ok).toBe(false);
    expect(out.lines).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toContain("no_parts_list");
  });

  it("warns when the title block has no drawing/part number", () => {
    const out = extractAssemblyFromDxf(dxf([
      [0, "SECTION"], [2, "ENTITIES"],
      ...insert("BOMROW", [["ITEM", "1"], ["PART_NO", "X-1"], ["QTY", "1"]]),
      [0, "ENDSEC"], [0, "EOF"],
    ]));
    expect(out.asset.asset_code).toBe("");
    expect(out.warnings.map((w) => w.code)).toContain("missing_asset_code");
  });
});
