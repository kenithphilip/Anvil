// Unit tests for the BOM source-format engine (_lib/bom-format.js):
// header detection, format detection (India/Korea/China/Japan/generic),
// column mapping, and per-format line normalization. Pure, no I/O.

import { describe, it, expect } from "vitest";
import { BUILTIN_FORMATS, mergeFormats, findHeaderRow, detectFormatKey, mapSheet } from "../api/_lib/bom-format.js";

const F = BUILTIN_FORMATS;

describe("findHeaderRow", () => {
  it("finds the row with both a part-no and a part-name label", () => {
    const rows = [["Some title"], ["Part No", "Part Name", "Qty"], ["A", "Widget", 2]];
    expect(findHeaderRow(rows)).toBe(1);
  });
});

describe("detectFormatKey", () => {
  it("India: plain English headers, no script -> floor priority beats generic", () => {
    const rows = [["Part No", "Part Name", "Qty", "Material"], ["A", "x", 1, "EN8"]];
    expect(detectFormatKey(rows, "BOM.xlsx", F)).toBe("obara_india");
  });
  it("Korea: Hangul anywhere -> obara_korea", () => {
    const rows = [["부품 목록"], ["Part No", "Part Name", "Lv"], ["A", "x", "1"]];
    expect(detectFormatKey(rows, "x.xlsx", F)).toBe("obara_korea");
  });
  it("Korea: filename hint when no Hangul", () => {
    const rows = [["Part No", "Part Name"], ["A", "x"]];
    expect(detectFormatKey(rows, "IXM22-0556.xlsx", F)).toBe("obara_korea");
  });
  it("China: PARTS CODE + JPN MODEL headers -> obara_china", () => {
    const rows = [["MESSRS.:", "ACME"], ["Item No", "Parts Code", "Part Name", "JPN MODEL", "LEVEL"], ["1", "BADC1", "x", "M", "1"]];
    expect(detectFormatKey(rows, "x.xlsx", F)).toBe("obara_china");
  });
  it("Japan: Structure header -> obara_japan (beats china on priority)", () => {
    const rows = [["Bill of Materials"], ["Structure", "Item No", "Part Name", "LR is or not"], ["14", "P1", "x", "無"]];
    expect(detectFormatKey(rows, "x.xlsx", F)).toBe("obara_japan");
  });
  it("Generic: unknown headers still map via generic_flat fallback", () => {
    const onlyGeneric = F.filter((f) => f.key === "generic_flat");
    const rows = [["SKU", "Description", "Quantity"], ["S1", "x", 3]];
    expect(detectFormatKey(rows, "x.xlsx", onlyGeneric)).toBe("generic_flat");
  });
});

describe("mapSheet - India (flat)", () => {
  it("maps part_no/name/qty/material, no level", () => {
    const rows = [["Part No", "Part Name", "Qty", "Material"], ["A1", "Widget", "2", "EN8"], ["A2", "Gear", "1", "C45"]];
    const out = mapSheet(rows, "GUN-1.xlsx", F);
    expect(out.source_format).toBe("obara_india");
    expect(out.asset.asset_code).toBe("GUN-1");
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ seq_no: 1, part_no: "A1", part_name: "Widget", qty: 2, material: "EN8", level: null });
  });
});

describe("mapSheet - China (parts code + level)", () => {
  it("uses PARTS CODE as part_no, keeps it as supplier_part_no, reads LEVEL", () => {
    const rows = [
      ["MESSRS.:", "ACME CORP"],
      ["Item No", "Parts Code", "Part Name", "JPN MODEL", "LEVEL", "Q'ty"],
      ["1", "BADC026391A", "Tip", "M-1", "2", "4"],
    ];
    const out = mapSheet(rows, "PROD.xlsx", F);
    expect(out.source_format).toBe("obara_china");
    expect(out.lines[0]).toMatchObject({
      part_no: "BADC026391A",
      supplier_part_no: "BADC026391A",
      part_name: "Tip",
      level: 2,
      qty: 4,
    });
    // jpn model folded into remarks via remarks_append
    expect(out.lines[0].remarks).toContain("M-1");
    // customer label captured if meta_labels present (none configured -> null)
    expect(out.lines[0].std_category).toBeNull();
  });
  it("fractional qty preserved", () => {
    const rows = [["Item No", "Parts Code", "Part Name", "JPN MODEL", "LEVEL", "Q'ty"], ["1", "GLUE", "Glue", "", "3", "0.01"]];
    const out = mapSheet(rows, "x.xlsx", F);
    expect(out.lines[0].qty).toBe(0.01);
  });
});

describe("mapSheet - Japan (dotted structure level + LR)", () => {
  it("derives level from dotted Structure and normalizes 有/無", () => {
    const rows = [
      ["Bill of Materials"],
      ["Structure", "Item No", "Part Name", "Material", "LR is or not", "Q'ty"],
      ["14", "TOP", "Assy", "", "無", "1"],
      ["14 .1", "SUB", "Sub", "C06", "有", "2"],
      ["14 .1.1", "LEAF", "Leaf", "", "無", "3"],
    ];
    const out = mapSheet(rows, "SRTC-7913-L.xlsx", F);
    expect(out.source_format).toBe("obara_japan");
    expect(out.lines.map((l) => l.level)).toEqual([1, 2, 3]);
    // 無 (no) clears LR; 有 (yes) inherits from filename suffix -L
    expect(out.lines[0].lr).toBeNull();
    expect(out.lines[1].lr).toBe("L");
  });
});

describe("mapSheet - Korea (Lv level)", () => {
  it("reads Lv as level, Hangul triggers korea", () => {
    const rows = [
      ["Drawing No.", "", "IXM22-0556"],
      ["부품"],
      ["Part No", "Part Name", "Lv", "Q'ty"],
      ["K1", "Body", "1", "1"],
      ["K2", "Pin", "2", "4"],
    ];
    const out = mapSheet(rows, "x.xlsx", F);
    expect(out.source_format).toBe("obara_korea");
    expect(out.lines.map((l) => l.level)).toEqual([1, 2]);
  });
});

describe("mergeFormats", () => {
  it("tenant format overrides a built-in by key; new keys added; disabled dropped", () => {
    const merged = mergeFormats([
      { key: "obara_india", label: "Custom India", column_map: { part_no: ["pn"] }, enabled: true },
      { key: "acme", label: "Acme Supplier", column_map: { part_no: ["acme pn"] }, enabled: true },
      { key: "old", label: "Old", enabled: false },
    ]);
    const india = merged.find((f) => f.key === "obara_india");
    expect(india.label).toBe("Custom India");
    expect(india.is_builtin).toBe(false);
    expect(merged.find((f) => f.key === "acme")).toBeTruthy();
    expect(merged.find((f) => f.key === "old")).toBeFalsy();
    // other built-ins still present
    expect(merged.find((f) => f.key === "obara_china")).toBeTruthy();
  });
});
