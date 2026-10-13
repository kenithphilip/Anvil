// Spare matrix iteration (docs/SPARE_MATRIX_ITERATION.md): one column per part
// number, the 7 export headers, Consumables before Spares, and BOM-field
// (Material) discovery. Behaviour tests over the shared module
// (src/api/_lib/spare-matrix-columns.js) and the generator built on it.
// Invented fixtures only.

import { describe, it, expect } from "vitest";
import * as XLSXmod from "xlsx";
import { generateSpareMatrix, computeAutoFill, orderSpareColumns, buildSpareSheet, type SpareBomItem } from "./spare-match";
import {
  META_COLUMNS, EXTRA_META_COLUMNS, PART_NO_ROW_LABEL, layoutToAoa, columnGroupOf, parseSplitName,
  discoverBomFields, bomFieldIndex, bomFieldValue, normGroupName, normPartNo, planSpareColumns,
} from "../../api/_lib/spare-matrix-columns.js";

const XLSX: any = (XLSXmod as any).read ? XLSXmod : (XLSXmod as any).default;

const line = (part_no: string, part_name: string, extra: Partial<SpareBomItem> = {}): SpareBomItem => ({ part_no, part_name, material: "", size: "", ...extra });
const col = (col_name: string, col_type = "spare", extra: any = {}) => ({ id: "c-" + col_name, col_name, col_type, locked: false, ...extra });
const row = (gun_no: string, values: Record<string, string> = {}, extra: any = {}) => ({ id: "r-" + gun_no, gun_no, values, ...extra });
let seq = 0;
const makeId = () => "new-" + (++seq);
const names = (cols: any[]) => cols.map((c) => c.col_name);
const cell = (out: any, gun: string, colName: string) => (out.rows.find((r: any) => r.gun_no === gun)?.values || {})[colName];

// Three guns on two stations. ADAPTER has three part numbers; one of them is
// on two guns (two stations, two robots).
const LINES = new Map<string, SpareBomItem[]>([
  ["GUN-A1", [line("PN-1001", "ADAPTER"), line("TIP-77", "TIP", { material: "CuCrZr" }), line("PN-1002", "ADAPTER 16MM")]],
  ["GUN-B2", [line("PN-1003", "ADAPTER"), line("PN-1001", "ADAPTER")]],
  ["GUN-C3", [line("PN-1002", "ADAPTER 16MM"), line("TIP-77", "TIP", { material: "CuCrZr" })]],
]);
const ROWS = () => [
  row("GUN-A1", {}, { station_no: "ST-10", robot_no: "R1" }),
  row("GUN-B2", {}, { station_no: "ST-20", robot_no: "R2" }),
  row("GUN-C3", {}, { station_no: "ST-20", robot_no: "R3" }),
];

describe("requirement 1: one column per unique part number", () => {
  it("splits a name shared by distinct part numbers into ADAPTER-1..3", () => {
    const out = generateSpareMatrix({ cols: [col("ADAPTER", "consumable")], rows: ROWS(), linesByGun: LINES, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER-1", "ADAPTER-2", "ADAPTER-3"]);
    // Original BOM order: GUN-A1 line 0 = PN-1001, GUN-A1 line 2 = PN-1002, then GUN-B2's PN-1003.
    expect(cell(out, "GUN-A1", "ADAPTER-1")).toBe("PN-1001");
    expect(cell(out, "GUN-A1", "ADAPTER-2")).toBe("PN-1002");
    expect(cell(out, "GUN-B2", "ADAPTER-3")).toBe("PN-1003");
    // A cell holds exactly one part number, never a quantity.
    for (const r of out.rows) for (const v of Object.values(r.values)) expect(String(v)).not.toMatch(/\n/);
    expect(out.splits[0]).toMatchObject({ group: "ADAPTER", from: ["ADAPTER"], created: ["ADAPTER-1", "ADAPTER-2", "ADAPTER-3"] });
    // New columns inherit the category's type.
    expect(out.cols.every((c: any) => c.col_type === "consumable")).toBe(true);
  });

  it("maps the same part number to the same column on every gun, station and robot", () => {
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows: ROWS(), linesByGun: LINES, makeId });
    // PN-1001: GUN-A1 (ST-10/R1) and GUN-B2 (ST-20/R2). PN-1002: GUN-A1 and GUN-C3.
    expect(cell(out, "GUN-A1", "ADAPTER-1")).toBe("PN-1001");
    expect(cell(out, "GUN-B2", "ADAPTER-1")).toBe("PN-1001");
    expect(cell(out, "GUN-C3", "ADAPTER-1")).toBeUndefined();
    expect(cell(out, "GUN-A1", "ADAPTER-2")).toBe("PN-1002");
    expect(cell(out, "GUN-C3", "ADAPTER-2")).toBe("PN-1002");
    // Each column's part number is ONE value across the whole matrix.
    const sheet = buildSpareSheet({ cols: out.cols, rows: out.rows });
    expect(sheet.partColumns.map((p: any) => [p.header, p.part_no_label])).toEqual([
      ["ADAPTER-1", "PN-1001"], ["ADAPTER-2", "PN-1002"], ["ADAPTER-3", "PN-1003"],
    ]);
  });

  it("keeps today's name when the category has one part number", () => {
    const out = generateSpareMatrix({ cols: [col("TIP", "consumable")], rows: ROWS(), linesByGun: LINES, makeId });
    expect(names(out.cols)).toEqual(["TIP"]);
    expect(cell(out, "GUN-A1", "TIP")).toBe("TIP-77");
    expect(cell(out, "GUN-C3", "TIP")).toBe("TIP-77");
    expect(out.splits).toEqual([]);
  });

  it("groups similar names but never merges different part numbers", () => {
    // "ADAPTER" and "ADAPTER 16MM" are one category (size-only remainder);
    // "ADAPTER PLATE" is a different part and stays out of it.
    const lines = new Map([["G1", [line("PN-2001", "ADAPTER"), line("PN-2002", "Adapter 16mm"), line("PN-2003", "ADAPTER PLATE")]]]);
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows: [row("G1")], linesByGun: lines, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER-1", "ADAPTER-2"]);
    expect(Object.values(out.rows[0].values).sort()).toEqual(["PN-2001", "PN-2002"]);
  });

  it("does not merge part numbers that differ only in case; it flags them", () => {
    const lines = new Map([["G1", [line("PN-3001", "ADAPTER"), line("pn-3001", "ADAPTER")]]]);
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows: [row("G1")], linesByGun: lines, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER-1", "ADAPTER-2"]);
    expect(out.flags).toContainEqual(expect.objectContaining({ kind: "similar_part_no", part_nos: ["PN-3001", "pn-3001"] }));
  });

  it("never places or merges a BOM line with a blank part number; it flags it", () => {
    const lines = new Map([["G1", [line("PN-4001", "ADAPTER"), line("", "ADAPTER"), line("   ", "ADAPTER 20MM")]]]);
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows: [row("G1")], linesByGun: lines, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER"]);           // one identified part -> one column
    expect(out.rows[0].values).toEqual({ ADAPTER: "PN-4001" });
    const blanks = out.flags.filter((f) => f.kind === "no_part_no");
    expect(blanks).toHaveLength(2);
    expect(blanks[0]).toMatchObject({ group: "ADAPTER", gun_no: "G1", line: 2, description: "ADAPTER" });
  });

  it("flags one part number with inconsistent descriptions and keeps ONE column", () => {
    const lines = new Map([
      ["G1", [line("PN-5001", "ADAPTER 16MM")]],
      ["G2", [line("PN-5001", "ADAPTER 20MM")]],
    ]);
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows: [row("G1"), row("G2")], linesByGun: lines, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER"]);
    expect(out.flags).toContainEqual(expect.objectContaining({ kind: "inconsistent_description", part_no: "PN-5001", descriptions: ["ADAPTER 16MM", "ADAPTER 20MM"] }));
  });

  it("assigns the same suffixes on every repeated run, and a re-run changes nothing", () => {
    const a = generateSpareMatrix({ cols: [col("ADAPTER")], rows: ROWS(), linesByGun: LINES, makeId });
    const b = generateSpareMatrix({ cols: [col("ADAPTER")], rows: ROWS(), linesByGun: LINES, makeId });
    expect(names(a.cols)).toEqual(names(b.cols));
    expect(a.rows.map((r) => r.values)).toEqual(b.rows.map((r) => r.values));
    // Re-running on the generated matrix is a no-op.
    const again = generateSpareMatrix({ cols: a.cols, rows: a.rows, linesByGun: LINES, makeId });
    expect(names(again.cols)).toEqual(names(a.cols));
    expect(again.filled).toBe(0);
    expect(again.rows.map((r) => r.values)).toEqual(a.rows.map((r) => r.values));
  });

  it("keeps existing suffixes when a new part number appears (stable meaning)", () => {
    const first = generateSpareMatrix({ cols: [col("ADAPTER")], rows: ROWS(), linesByGun: LINES, makeId });
    // A new gun, listed FIRST, brings a new adapter part number.
    const more = new Map(LINES);
    more.set("GUN-Z0", [line("PN-0999", "ADAPTER"), line("PN-1003", "ADAPTER")]);
    const second = generateSpareMatrix({ cols: first.cols, rows: [row("GUN-Z0"), ...first.rows], linesByGun: more, makeId });
    const byPart = Object.fromEntries(buildSpareSheet({ cols: second.cols, rows: second.rows }).partColumns.map((p: any) => [p.part_no_label, p.header]));
    expect(byPart["PN-1001"]).toBe("ADAPTER-1");
    expect(byPart["PN-1002"]).toBe("ADAPTER-2");
    expect(byPart["PN-1003"]).toBe("ADAPTER-3");
    expect(byPart["PN-0999"]).toBe("ADAPTER-4");
    expect(cell(second, "GUN-Z0", "ADAPTER-3")).toBe("PN-1003");
  });

  it("splits an existing (pre-split) matrix losslessly, keeping manual part numbers", () => {
    // Saved before this change: one ADAPTER column, part numbers stacked in a
    // cell, plus a manually picked part that is in no BOM.
    const rows = [
      row("GUN-A1", { ADAPTER: "PN-1001\nPN-1002" }),
      row("GUN-B2", { ADAPTER: "PN-1003\nPN-1001\nPN-MANUAL-9" }),
      row("GUN-X9", { ADAPTER: "PN-1002" }),          // no BOM for this gun
    ];
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows, linesByGun: LINES, makeId });
    const sheet = buildSpareSheet({ cols: out.cols, rows: out.rows });
    const placed = (gun: string) => out.rows.find((r) => r.gun_no === gun).values;
    // Every part number that was in a cell is still on its gun, one per column.
    expect(Object.values(placed("GUN-A1")).sort()).toEqual(["PN-1001", "PN-1002"]);
    expect(Object.values(placed("GUN-B2")).sort()).toEqual(["PN-1001", "PN-1003", "PN-MANUAL-9"]);
    expect(Object.values(placed("GUN-X9"))).toEqual(["PN-1002"]);
    // The manual part sorts after every BOM-seen part.
    expect(sheet.partColumns.map((p: any) => p.part_no_label)).toEqual(["PN-1001", "PN-1002", "PN-1003", "PN-MANUAL-9"]);
    expect(out.emptyGuns).toBe(1);
  });

  it("leaves a category with a locked column exactly as it is", () => {
    const rows = [row("GUN-A1", { ADAPTER: "PN-1001\nPN-1002" })];
    const out = generateSpareMatrix({ cols: [col("ADAPTER", "spare", { locked: true })], rows, linesByGun: LINES, makeId });
    expect(names(out.cols)).toEqual(["ADAPTER"]);
    expect(out.rows[0]).toBe(rows[0]);
  });

  it("keeps row ids and gun numbers, so drawings stay linked to their gun row", () => {
    const rows = ROWS();
    const out = generateSpareMatrix({ cols: [col("ADAPTER")], rows, linesByGun: LINES, makeId });
    expect(out.rows.map((r) => [r.id, r.gun_no, r.station_no])).toEqual(rows.map((r) => [r.id, r.gun_no, r.station_no]));
  });

  it("computeAutoFill (row view) reports the split keys too", () => {
    const out = computeAutoFill(ROWS(), ["ADAPTER"], LINES);
    expect(Object.keys(out.rows[0].values).sort()).toEqual(["ADAPTER-1", "ADAPTER-2"]);
  });

  it("columnGroupOf only cuts a suffix when the column really is a split member", () => {
    expect(columnGroupOf("ADAPTER-2", ["ADAPTER-1", "ADAPTER-2"])).toBe("ADAPTER");
    expect(columnGroupOf("ADAPTER-2", ["ADAPTER", "ADAPTER-2"])).toBe("ADAPTER");
    expect(columnGroupOf("M-8", ["M-8", "TIP"])).toBe("M-8");             // hand-made name, no sibling
    expect(columnGroupOf("TIP", ["TIP"])).toBe("TIP");
    expect(parseSplitName("O-RING")).toBeNull();
    expect(parseSplitName("O-RING-12")).toEqual({ base: "O-RING", n: 12 });
  });

  it("documents the normalisation policy", () => {
    expect(normGroupName("  adapter   16mm ")).toBe("ADAPTER 16MM");
    expect(normPartNo("  pn-1001 ")).toBe("pn-1001");                    // trimmed only
  });
});

describe("requirement 3: Consumables before Spares, explicit fallback", () => {
  const cols = [
    col("GEAR CASE", "spare"),
    col("KIT A", "kit"),
    col("TIP", "consumable"),
    col("BOLT", "Hardware"),
    col("SHANK", "spare"),         // default type, but a consumable preset name
    col("ARM", ""),                // blank type = spare (the worksheet default)
    col("SHUNT", "Consumable"),
  ];

  it("puts every Consumable before every Spare, then the fallback class, never dropping one", () => {
    const ordered = names(orderSpareColumns(cols));
    expect(ordered).toEqual(["TIP", "SHANK", "SHUNT", "GEAR CASE", "ARM", "KIT A", "BOLT"]);
    expect(ordered).toHaveLength(cols.length);
  });

  it("keeps the relative order inside each class (stable)", () => {
    const ordered = names(orderSpareColumns([col("B-SPARE"), col("TIP", "consumable"), col("A-SPARE"), col("SHUNT", "consumable")]));
    expect(ordered).toEqual(["TIP", "SHUNT", "B-SPARE", "A-SPARE"]);
  });

  it("classifies split columns by their category", () => {
    const split = [col("ARM"), col("SHANK-1", "spare"), col("SHANK-2", "spare")];
    expect(names(orderSpareColumns(split))).toEqual(["SHANK-1", "SHANK-2", "ARM"]);
  });

  it("keeps part data with its column after sorting", () => {
    const rows = [row("G1", { "GEAR CASE": "GC-1", TIP: "TIP-1", "KIT A": "K-1" })];
    const sheet = buildSpareSheet({ cols, rows });
    const aoa = layoutToAoa(sheet, rows);
    const header = aoa[0];
    const data = aoa[2];
    expect(data[header.indexOf("TIP")]).toBe("TIP-1");
    expect(data[header.indexOf("GEAR CASE")]).toBe("GC-1");
    expect(data[header.indexOf("KIT A")]).toBe("K-1");
  });
});

describe("requirement 2: exactly 7 metadata headers, in order", () => {
  const SEVEN = ["GUN NO.", "LINE", "STATION", "ROBOT", "GUN TYPE", "ATDC/ATD", "QTY"];
  const rows = [row("GUN-A1", { "ARM-1": "PN-1001", TIP: "TIP-77" }, { line: "L1", station_no: "ST-10", robot_no: "R1", gun_type: "X", atd: "ATD-5", qty: 2, l_qty: 1, r_qty: 1, timer: "T-9" })];
  const cols = [col("ARM-1"), col("ARM-2"), col("TIP", "consumable")];

  it("writes the 7 headers first, exactly, then the kept extras, then the parts (parsed xlsx)", () => {
    const aoa = layoutToAoa(buildSpareSheet({ cols, rows }), rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Spare Matrix");
    const parsed = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
    const got: any[][] = XLSX.utils.sheet_to_json(parsed.Sheets["Spare Matrix"], { header: 1, defval: "" });
    expect(got[0].slice(0, 7)).toEqual(SEVEN);
    expect(got[0].slice(7, 10)).toEqual(["L-QTY", "R-QTY", "TIMER"]);
    expect(got[0].slice(10)).toEqual(["TIP", "ARM-1", "ARM-2"]);   // part headers unchanged by the relabel
    // No blank or duplicate header.
    expect(got[0].every((h) => String(h).trim() !== "")).toBe(true);
    expect(new Set(got[0]).size).toBe(got[0].length);
    // PART NO. row, then the data, aligned under the right headers.
    expect(got[1][0]).toBe(PART_NO_ROW_LABEL);
    expect(got[1].slice(10)).toEqual(["TIP-77", "PN-1001", ""]);
    const data = Object.fromEntries(got[0].map((h, i) => [h, got[2][i]]));
    expect(data).toMatchObject({ "GUN NO.": "GUN-A1", LINE: "L1", STATION: "ST-10", ROBOT: "R1", "GUN TYPE": "X", "ATDC/ATD": "ATD-5", QTY: 2, "L-QTY": 1, "R-QTY": 1, TIMER: "T-9", TIP: "TIP-77", "ARM-1": "PN-1001" });
  });

  it("META_COLUMNS is the single source of the 7 labels", () => {
    expect(META_COLUMNS.map((m) => m.header)).toEqual(SEVEN);
    expect(EXTRA_META_COLUMNS.map((m) => m.key)).toEqual(["l_qty", "r_qty", "timer"]);
  });

  it("JSON keeps one object per gun, with no metadata rows", () => {
    const aoa = layoutToAoa(buildSpareSheet({ cols, rows }), rows, { metaRows: false });
    expect(aoa).toHaveLength(2);
    expect(aoa[1][0]).toBe("GUN-A1");
  });
});

describe("requirement 4: Material discovery for Columns from BOM", () => {
  it("offers Material when the BOM lines carry it, mapped from the material field", () => {
    const lines = [
      { id: "x1", tenant_id: "t", asset_id: "a", seq_no: 1, part_no: "PN-1", part_name: "TIP", material: "CuCrZr", size: "16", qty: 2, level: 1, raw: {} },
      { id: "x2", tenant_id: "t", asset_id: "a", seq_no: 2, part_no: "PN-2", part_name: "ARM", material: null, size: "", qty: 1, level: 1, raw: {} },
    ];
    const d = discoverBomFields(lines);
    const mat = d.fields.find((f: any) => f.key === "material");
    expect(mat).toMatchObject({ label: "Material", count: 1, samples: ["CuCrZr"] });
    expect(d.fields[0].key).toBe("material");                        // listed first
    // Part number, quantity and structure are excluded WITH a reason; internal ids are not shown.
    expect(d.excluded.map((x: any) => x.label).sort()).toEqual(["Level", "Part No.", "Qty"]);
    expect(d.excluded.every((x: any) => x.reason)).toBe(true);
    expect(d.fields.some((f: any) => ["id", "tenant_id", "asset_id", "seq_no"].includes(f.key))).toBe(false);
    // Selecting it maps the right source values, per part number.
    expect(bomFieldIndex(lines, ["material"]).material.get("PN-1")).toEqual(["CuCrZr"]);
    expect(bomFieldIndex(lines, ["material"]).material.has("PN-2")).toBe(false);
  });

  it("reports Material as unavailable (with a reason) when no line has it", () => {
    const legacy = [{ parent_part_no: "G1", child_part_no: "PN-9", part_no: "PN-9", part_name: "TIP", material: "", size: "", qty: 1, uom: "Nos" }];
    const d = discoverBomFields(legacy);
    expect(d.fields.some((f: any) => f.key === "material")).toBe(false);
    expect(d.unavailable).toContainEqual(expect.objectContaining({ key: "material", label: "Material" }));
    expect(d.fields.map((f: any) => f.key)).toEqual(["part_name", "uom"]);
  });

  it("matches original headers across case, spaces and punctuation, keeping the labels", () => {
    const lines = [
      { part_no: "PN-1", raw: { " MATERIAL ": "SS304" } },
      { part_no: "PN-2", raw: { "Mat.": "CuCr" } },
      { part_no: "PN-3", raw: { "material_grade": "C18150" } },
    ];
    const d = discoverBomFields(lines);
    const mat = d.fields.find((f: any) => f.key === "material");
    expect(mat.count).toBe(3);
    expect(mat.source_labels).toEqual(["MATERIAL", "Mat.", "material_grade"]);
    expect(bomFieldValue(lines[1], "material")).toBe("CuCr");
  });

  it("handles duplicate headers: both labels kept, first non-empty value used", () => {
    const lines = [{ part_no: "PN-1", raw: { Material: "", MATERIAL: "SS304" } }];
    const d = discoverBomFields(lines);
    const mat = d.fields.find((f: any) => f.key === "material");
    expect(mat.duplicate_headers).toBe(true);
    expect(mat.source_labels).toEqual(["Material", "MATERIAL"]);
    expect(bomFieldValue(lines[0], "material")).toBe("SS304");
  });

  it("never treats Material Number or Part Description as Material", () => {
    const lines = [{ part_no: "PN-1", raw: { "Material Number": "100-200", "Part Description": "TIP CAP", "Part Number": "PN-1" } }];
    const d = discoverBomFields(lines);
    expect(d.fields.some((f: any) => f.key === "material")).toBe(false);
    expect(d.fields.find((f: any) => f.label === "Material Number")).toBeTruthy();
    expect(d.fields.find((f: any) => f.key === "part_name")).toMatchObject({ label: "Description" });
    expect(d.excluded.map((x: any) => x.label)).toContain("Part No.");
  });

  it("adds a selected BOM field as a header row, shared by preview and export", () => {
    const rows = [row("G1", { TIP: "PN-1" })];
    const lines = [{ part_no: "PN-1", material: "CuCrZr" }];
    const sheet = buildSpareSheet({ cols: [col("TIP", "consumable")], rows, attributes: [{ key: "material", label: "Material", byPart: bomFieldIndex(lines, ["material"]).material }] });
    expect(sheet.metaRows.map((m: any) => m.label)).toEqual([PART_NO_ROW_LABEL, "MATERIAL"]);
    const aoa = layoutToAoa(sheet, rows);
    expect(aoa[2][0]).toBe("MATERIAL");
    expect(aoa[2][10]).toBe("CuCrZr");
  });
});

describe("planner guards", () => {
  it("leaves split columns alone when there is nothing to place", () => {
    const cols = [col("ADAPTER-1"), col("ADAPTER-2")];
    const out = planSpareColumns({ cols, rows: [row("G1")], matchesByRow: [null], makeId });
    expect(names(out.cols)).toEqual(["ADAPTER-1", "ADAPTER-2"]);
  });
});
