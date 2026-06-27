// Unit tests for src/api/_lib/gun-drawings.js — drawing format inference +
// the CAD mime allowlist used by the documents upload boundary.

import { describe, it, expect } from "vitest";
import { inferDrawingFormat, DRAWING_MIME, DRAWING_FORMATS } from "../api/_lib/gun-drawings.js";

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

describe("DRAWING_MIME", () => {
  it("covers common CAD mimes for the upload allowlist", () => {
    for (const m of ["image/vnd.dwg", "application/acad", "model/step", "application/step", "image/vnd.dxf"]) {
      expect(DRAWING_MIME.has(m)).toBe(true);
    }
  });
});
