// PDM P0: reverse where-used resolution — a spare/child part -> the assemblies
// that contain it. Tests the pure enrichment/filter (buildAssemblies); the
// recursive graph itself is exercised by the v_bom_where_used_recursive view.

import { describe, it, expect } from "vitest";
import { buildAssemblies } from "../api/bom/where_used.js";

const rows = [
  { assembly_part_no: "SUB-40", depth: 1, total_qty: "2" },   // a sub-assembly (in item_master, not a registered asset)
  { assembly_part_no: "GUN-X7", depth: 2, total_qty: "2" },   // a registered asset/gun
  { assembly_part_no: "ORPHAN", depth: 1, total_qty: "1" },   // neither
];
const assetByCode = { "GUN-X7": { id: "a1", asset_code: "GUN-X7", name: "Welding Gun X7", revision: "B", drawing_no: "D-9001", customer_id: "c1" } };
const itemByPart = {
  "SUB-40": { part_no: "SUB-40", is_assembly: true, description: "Shank sub-assembly", item_type: "GUN_COMPONENT" },
  "GUN-X7": { part_no: "GUN-X7", is_assembly: true, description: "Gun X7", item_type: "GUN" },
};

describe("buildAssemblies", () => {
  it("enriches each ancestor with asset + item context and coerces qty", () => {
    const out = buildAssemblies(rows, assetByCode, itemByPart);
    expect(out).toHaveLength(3);
    const gun = out.find((a) => a.assembly_part_no === "GUN-X7");
    expect(gun).toMatchObject({ is_asset: true, asset_id: "a1", asset_name: "Welding Gun X7", drawing_no: "D-9001", is_assembly: true, item_type: "GUN", qty_per_assembly: 2, depth: 2 });
    const sub = out.find((a) => a.assembly_part_no === "SUB-40");
    expect(sub).toMatchObject({ is_asset: false, is_assembly: true, item_type: "GUN_COMPONENT" });
    const orphan = out.find((a) => a.assembly_part_no === "ORPHAN");
    expect(orphan).toMatchObject({ is_asset: false, is_assembly: null, description: null });
  });

  it("roots_only keeps only registered assets (the top-level guns)", () => {
    const out = buildAssemblies(rows, assetByCode, itemByPart, true);
    expect(out.map((a) => a.assembly_part_no)).toEqual(["GUN-X7"]);
  });

  it("handles empty input", () => {
    expect(buildAssemblies([], {}, {})).toEqual([]);
    expect(buildAssemblies(null)).toEqual([]);
  });
});
