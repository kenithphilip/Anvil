// Unit tests for src/api/_lib/gun-drawings.js — drawing format inference +
// the CAD mime allowlist used by the documents upload boundary.

import { describe, it, expect } from "vitest";
import { inferDrawingFormat, DRAWING_MIME, DRAWING_FORMATS, normalizeGunNo, vetDrawingMatch } from "../api/_lib/gun-drawings.js";

describe("inferDrawingFormat", () => {
  it("infers from extension first", () => {
    expect(inferDrawingFormat("X2C-ASSY.pdf", "application/octet-stream")).toBe("pdf");
    expect(inferDrawingFormat("gun.DWG", "")).toBe("dwg");
    expect(inferDrawingFormat("part.dxf", "")).toBe("dwg");
    expect(inferDrawingFormat("model.step", "")).toBe("step");
    expect(inferDrawingFormat("model.STP", "")).toBe("step");
  });
  it("falls back to mime when extension is unknown", () => {
    expect(inferDrawingFormat("blob", "application/pdf")).toBe("pdf");
    expect(inferDrawingFormat("blob", "image/vnd.dwg")).toBe("dwg");
    expect(inferDrawingFormat("blob", "model/step")).toBe("step");
    expect(inferDrawingFormat("blob", "application/p21")).toBe("step");
  });
  it("returns other for anything else", () => {
    expect(inferDrawingFormat("notes.txt", "text/plain")).toBe("other");
    expect(inferDrawingFormat("", "")).toBe("other");
  });
  it("only emits canonical formats", () => {
    for (const name of ["a.pdf", "a.dwg", "a.step", "a.bin"]) {
      expect(DRAWING_FORMATS.has(inferDrawingFormat(name, ""))).toBe(true);
    }
  });
});

describe("normalizeGunNo", () => {
  it("strips separators + case for tolerant matching", () => {
    expect(normalizeGunNo("X2C-X MEDIUM")).toBe("X2CXMEDIUM");
    expect(normalizeGunNo("x2c_x_medium")).toBe("X2CXMEDIUM");
    expect(normalizeGunNo(null)).toBe("");
  });
});

describe("vetDrawingMatch", () => {
  const gunNo = "X2C-X-MEDIUM";
  it("verified when the asset number is in the OCR'd content", () => {
    const v = vetDrawingMatch({ gunNo, filename: "scan001.pdf", text: "TITLE BLOCK ... DRG X2C X MEDIUM REV B", ocrStatus: "ocr" });
    expect(v.content_match).toBe(true);
    expect(v.verdict).toBe("verified");
    expect(v.blocked).toBe(false);
  });
  it("filename_only when name matches but content does not mention it", () => {
    const v = vetDrawingMatch({ gunNo, filename: "X2C_X_MEDIUM_assembly.pdf", text: "some other drawing text", ocrStatus: "text_layer" });
    expect(v.filename_match).toBe(true);
    expect(v.content_match).toBe(false);
    expect(v.verdict).toBe("filename_only");
    expect(v.blocked).toBe(false);
  });
  it("mismatch (blocked) when content is readable but the number is absent everywhere", () => {
    const v = vetDrawingMatch({ gunNo, filename: "random.pdf", text: "a totally different part Z9", ocrStatus: "text_layer" });
    expect(v.verdict).toBe("mismatch");
    expect(v.blocked).toBe(true);
  });
  it("unverifiable (blocked) for unreadable binary with a non-matching name", () => {
    const v = vetDrawingMatch({ gunNo, filename: "drawing12.dwg", text: "", ocrStatus: "binary_unreadable" });
    expect(v.content_checkable).toBe(false);
    expect(v.verdict).toBe("unverifiable");
    expect(v.blocked).toBe(true);
  });
  it("binary DWG passes when the file name carries the asset number", () => {
    const v = vetDrawingMatch({ gunNo, filename: "X2C-X-MEDIUM.dwg", text: "", ocrStatus: "binary_unreadable" });
    expect(v.filename_match).toBe(true);
    expect(v.verdict).toBe("filename_only");
    expect(v.blocked).toBe(false);
  });
});

describe("DRAWING_MIME", () => {
  it("covers common CAD mimes for the upload allowlist", () => {
    for (const m of ["image/vnd.dwg", "application/acad", "model/step", "application/step", "image/vnd.dxf"]) {
      expect(DRAWING_MIME.has(m)).toBe(true);
    }
  });
});
