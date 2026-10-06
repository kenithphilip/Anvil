// Unit tests for the pure filename -> gun matcher (src/api/_lib/gun-drawing-match.js).
// Covers the real-world cases the bulk drawing upload must handle: an EG-sheet
// filename that is the bare gun number OR the gun number + a suffix; 2D as PDF
// or DWG; 3D as STEP; wrong file type for the chosen batch kind; ambiguous and
// unmatched guns; and within-batch duplicates.

import { describe, it, expect } from "vitest";
import {
  extensionOf, formatOf, normGun, gunCandidates, buildGunIndex, matchFile, matchBatch, KIND_FORMATS,
} from "../api/_lib/gun-drawing-match.js";

const guns = (arr) => arr.map((g, i) => ({ id: "row-" + i, gun_no: g }));
const idx = (arr) => buildGunIndex(guns(arr));

describe("format classification", () => {
  it("reads the extension case-insensitively", () => {
    expect(extensionOf("GUN-12.PDF")).toBe("pdf");
    expect(extensionOf("model.STP")).toBe("stp");
    expect(extensionOf("noext")).toBe("");
  });
  it("maps extensions to formats (pdf / dwg / step)", () => {
    expect(formatOf("a.pdf")).toBe("pdf");
    expect(formatOf("a.dwg")).toBe("dwg");
    expect(formatOf("a.dxf")).toBe("dwg");   // DXF is a 2D CAD format -> dwg bucket
    expect(formatOf("a.step")).toBe("step");
    expect(formatOf("a.stp")).toBe("step");
    expect(formatOf("a.xlsx")).toBe(null);
  });
  it("declares which formats each kind accepts", () => {
    expect([...KIND_FORMATS.eg_sheet]).toEqual(["pdf"]);
    expect(KIND_FORMATS.drawing_2d.has("dwg")).toBe(true);
    expect(KIND_FORMATS.drawing_2d.has("pdf")).toBe(true);
    expect(KIND_FORMATS.drawing_3d.has("step")).toBe(true);
    expect(KIND_FORMATS.drawing_3d.has("pdf")).toBe(false);
  });
});

describe("normGun is conservative (keeps significant separators)", () => {
  it("uppercases + collapses whitespace but keeps - . _", () => {
    expect(normGun("  gun-12 a ")).toBe("GUN-12 A");
    expect(normGun("GUN.12")).not.toBe(normGun("GUN-12")); // '.' vs '-' stay distinct
  });
});

describe("gunCandidates peels trailing suffixes (full stem first)", () => {
  it("returns the bare stem then progressively suffix-stripped forms", () => {
    expect(gunCandidates("GUN-12_EG.pdf")[0]).toBe("GUN-12_EG");
    expect(gunCandidates("GUN-12_EG.pdf")).toContain("GUN-12");
    expect(gunCandidates("GUN-12 (2).pdf")).toContain("GUN-12");
    expect(gunCandidates("GUN-12_R1.pdf")).toContain("GUN-12");
  });
});

describe("matchFile", () => {
  it("matches an EG sheet whose filename IS the bare gun number", () => {
    const r = matchFile("GUN-12.pdf", "eg_sheet", idx(["GUN-12", "GUN-13"]));
    expect(r.status).toBe("matched");
    expect(r.gun_no).toBe("GUN-12");
    expect(r.row_id).toBe("row-0");
    expect(r.format).toBe("pdf");
  });

  it("matches an EG sheet with a suffix by peeling it (matched_suffix)", () => {
    const r = matchFile("GUN-12_EG.pdf", "eg_sheet", idx(["GUN-12", "GUN-13"]));
    expect(r.status).toBe("matched_suffix");
    expect(r.gun_no).toBe("GUN-12");
    expect(r.detail.suffix_stripped).toBe(true);
  });

  it("matches a copy-suffixed file: 'GUN-12 (2).pdf'", () => {
    const r = matchFile("GUN-12 (2).pdf", "eg_sheet", idx(["GUN-12"]));
    expect(r.status).toBe("matched_suffix");
    expect(r.gun_no).toBe("GUN-12");
  });

  it("accepts a 2D drawing as DWG", () => {
    const r = matchFile("GUN-12.dwg", "drawing_2d", idx(["GUN-12"]));
    expect(r.status).toBe("matched");
    expect(r.format).toBe("dwg");
  });

  it("accepts a 3D model as STEP", () => {
    const r = matchFile("GUN-12.step", "drawing_3d", idx(["GUN-12"]));
    expect(r.status).toBe("matched");
    expect(r.format).toBe("step");
  });

  it("flags wrong_type: a STEP in an EG-sheet batch", () => {
    const r = matchFile("GUN-12.step", "eg_sheet", idx(["GUN-12"]));
    expect(r.status).toBe("wrong_type");
    expect(r.gun_no).toBe(null);
  });

  it("flags wrong_type: a PDF in a 3D batch", () => {
    const r = matchFile("GUN-12.pdf", "drawing_3d", idx(["GUN-12"]));
    expect(r.status).toBe("wrong_type");
  });

  it("flags wrong_type: an unknown extension", () => {
    expect(matchFile("GUN-12.xlsx", "eg_sheet", idx(["GUN-12"])).status).toBe("wrong_type");
  });

  it("returns unmatched when no gun corresponds", () => {
    const r = matchFile("GUN-99.pdf", "eg_sheet", idx(["GUN-12", "GUN-13"]));
    expect(r.status).toBe("unmatched");
    expect(r.gun_no).toBe(null);
  });

  it("flags ambiguous when separator variants collide on the loose tier", () => {
    // 'GUN12.pdf' exact-misses both, then loose-matches 'GUN 12' AND 'GUN-12'.
    const r = matchFile("GUN12.pdf", "eg_sheet", idx(["GUN 12", "GUN-12"]));
    expect(r.status).toBe("ambiguous");
    expect(r.detail.candidates.sort()).toEqual(["GUN 12", "GUN-12"]);
  });

  it("does NOT peel a suffix into a false match when the full stem already matches", () => {
    // Full stem 'GUN-2D' exists as a real gun -> must win over peeling '_2D'.
    const r = matchFile("GUN-2D.pdf", "eg_sheet", idx(["GUN-2D", "GUN"]));
    expect(r.status).toBe("matched");
    expect(r.gun_no).toBe("GUN-2D");
  });
});

describe("matchBatch", () => {
  it("flags a second file landing on the same gun as duplicate", () => {
    const files = [{ filename: "GUN-12.pdf" }, { filename: "GUN-12_EG.pdf" }, { filename: "GUN-13.pdf" }];
    const out = matchBatch(files, "eg_sheet", guns(["GUN-12", "GUN-13"]));
    expect(out[0].status).toBe("matched");
    expect(out[1].status).toBe("duplicate");
    expect(out[1].detail.duplicate_of_index).toBe(0);
    expect(out[2].status).toBe("matched");
  });

  it("reads filename from either `filename` or `original_filename`", () => {
    const out = matchBatch([{ original_filename: "GUN-12.pdf" }], "eg_sheet", guns(["GUN-12"]));
    expect(out[0].status).toBe("matched");
    expect(out[0].gun_no).toBe("GUN-12");
  });
});
