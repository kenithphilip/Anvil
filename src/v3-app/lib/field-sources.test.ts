// Unit tests for the per-field provenance helper. The recon table
// and Header fields tab rely on this to render OCR vs operator-
// edited pills correctly.

import { describe, it, expect } from "vitest";
import {
  stampOcrSources,
  getFieldSource,
  markFieldEdited,
  CANONICAL_LINE_FIELDS,
} from "./field-sources";

describe("stampOcrSources", () => {
  it("stamps each populated field as ocr", () => {
    const line = { partNumber: "BR-6204", description: "Bearing", quantity: 5, unitPrice: 1000 };
    const stamped = stampOcrSources(line);
    expect(stamped._field_sources).toEqual({
      itemCode: "ocr",
      description: "ocr",
      qty: "ocr",
      rate: "ocr",
    });
  });

  it("ignores empty / null / undefined fields", () => {
    const line = { partNumber: "", description: null, quantity: 5, unitPrice: undefined, uom: "Nos" };
    const stamped = stampOcrSources(line);
    expect(stamped._field_sources).toEqual({ qty: "ocr", uom: "ocr" });
  });

  it("respects an existing _field_sources map (re-runs do not stomp human edits)", () => {
    const line = {
      partNumber: "X",
      _field_sources: { itemCode: "human" as const },
    };
    const stamped = stampOcrSources(line);
    expect(stamped._field_sources).toEqual({ itemCode: "human" });
  });

  it("returns a new object (immutable)", () => {
    const line = { partNumber: "X" };
    const stamped = stampOcrSources(line);
    expect(stamped).not.toBe(line);
    expect((line as any)._field_sources).toBeUndefined();
  });

  it("covers every canonical field", () => {
    // Catches the regression where a new canonical field is added
    // to ALIASES but stampOcrSources skips it.
    const all = {
      itemCode: "A",
      description: "B",
      qty: 1,
      rate: 2,
      uom: "Nos",
      hsn: "8482",
      gst_pct: 18,
    };
    const stamped = stampOcrSources(all);
    for (const k of CANONICAL_LINE_FIELDS) {
      expect(stamped._field_sources?.[k]).toBe("ocr");
    }
  });
});

describe("getFieldSource", () => {
  it("returns null when no provenance is recorded", () => {
    expect(getFieldSource({}, "qty")).toBeNull();
    expect(getFieldSource(null, "qty")).toBeNull();
    expect(getFieldSource(undefined, "qty")).toBeNull();
  });
  it("returns recorded source for known fields", () => {
    const line = { _field_sources: { qty: "ocr" as const, rate: "human" as const } };
    expect(getFieldSource(line, "qty")).toBe("ocr");
    expect(getFieldSource(line, "rate")).toBe("human");
    expect(getFieldSource(line, "description")).toBeNull();
  });
});

describe("markFieldEdited", () => {
  it("flips the canonical key to human", () => {
    const line = { _field_sources: { qty: "ocr" as const } };
    const edited = markFieldEdited(line, "qty");
    expect(edited._field_sources).toEqual({ qty: "human" });
  });
  it("preserves other keys", () => {
    const line = { _field_sources: { qty: "ocr" as const, rate: "ocr" as const } };
    const edited = markFieldEdited(line, "qty");
    expect(edited._field_sources).toEqual({ qty: "human", rate: "ocr" });
  });
  it("creates the _field_sources map if absent", () => {
    const edited = markFieldEdited({} as any, "qty");
    expect(edited._field_sources).toEqual({ qty: "human" });
  });
  it("returns a new object (immutable)", () => {
    const line = { _field_sources: { qty: "ocr" as const } };
    const edited = markFieldEdited(line, "qty");
    expect(edited).not.toBe(line);
    expect(line._field_sources).toEqual({ qty: "ocr" });
  });
});
