// Unit tests for the per-field provenance helper. The recon table
// and Header fields tab rely on this to render OCR vs operator-
// edited pills correctly.

import { describe, it, expect } from "vitest";
import {
  stampOcrSources,
  getFieldSource,
  markFieldEdited,
  CANONICAL_LINE_FIELDS,
  buildExtractionIndex,
  issuesForCanonicalCell,
  worstSeverity,
} from "./field-sources";

const SAMPLE_RUN = {
  adapter_used: "claude",
  confidence_overall: 0.82,
  voter_used: true,
  field_provenance: [
    { field: "customer.gstin", source: "claude", confidence: 0.97, voters: [{ adapter: "claude", confidence: 0.97 }, { adapter: "reducto", confidence: 0.9 }] },
    { field: "lines[0].unitPrice", source: "reducto", confidence: 0.6 },
    { field: "lines[0].quantity", source: "template", confidence: 0.99 },
  ],
  validator_issues: [
    { field: "customer.gstin", code: "gstin_malformed", severity: "error", message: "bad gstin" },
    { field: "lines[0].unitPrice", code: "price_zero", severity: "warn", message: "price is zero" },
  ],
  validator_summary: { error: 1, warn: 1, info: 0, total: 2 },
  anomalies: [
    { code: "line_arithmetic_mismatch", severity: "error", path: "lines[0].line", line_index: 0, detail: "qty*rate != total" },
    { code: "grand_total_mismatch", severity: "warn", path: "totals.grand_total" },
  ],
  anomalies_summary: { error: 1, warn: 1, total: 2 },
};

describe("worstSeverity", () => {
  it("ranks error over warn over info", () => {
    expect(worstSeverity([{ severity: "warn" }, { severity: "error" }, { severity: "info" }])).toBe("error");
    expect(worstSeverity([{ severity: "info" }, { severity: "warn" }])).toBe("warn");
    expect(worstSeverity([])).toBe("");
  });
});

describe("buildExtractionIndex", () => {
  it("tolerates a null run", () => {
    const idx = buildExtractionIndex(null);
    expect(idx.allIssues).toEqual([]);
    expect(idx.lineProvenance(0, "rate")).toBeNull();
    expect(idx.summary.validator.total).toBe(0);
  });

  it("indexes provenance by line + canonical key (rate -> unitPrice)", () => {
    const idx = buildExtractionIndex(SAMPLE_RUN);
    const prov = idx.lineProvenance(0, "rate");
    expect(prov?.source).toBe("reducto");
    expect(prov?.confidence).toBe(0.6);
    expect(idx.lineProvenance(0, "qty")?.source).toBe("template");
    expect(idx.headerProvenance("customer.gstin")?.source).toBe("claude");
  });

  it("groups validator + anomaly issues onto the right line", () => {
    const idx = buildExtractionIndex(SAMPLE_RUN);
    const line0 = idx.lineIssues(0);
    // unitPrice validator warn + line0 anomaly error
    expect(line0.length).toBe(2);
    expect(line0.some((x) => x.kind === "validator" && x.code === "price_zero")).toBe(true);
    expect(line0.some((x) => x.kind === "anomaly" && x.severity === "error")).toBe(true);
  });

  it("keeps header + totals issues out of the line buckets", () => {
    const idx = buildExtractionIndex(SAMPLE_RUN);
    expect(idx.headerIssues("customer.gstin").length).toBe(1);
    expect(idx.headerIssues("totals.grand_total").length).toBe(1);
  });

  it("rolls up the summary from the *_summary columns", () => {
    const idx = buildExtractionIndex(SAMPLE_RUN);
    expect(idx.summary.adapter).toBe("claude");
    expect(idx.summary.confidence).toBe(0.82);
    expect(idx.summary.voterUsed).toBe(true);
    expect(idx.summary.validator).toMatchObject({ error: 1, warn: 1, total: 2 });
    expect(idx.summary.anomalies).toMatchObject({ error: 1, total: 2 });
  });
});

describe("issuesForCanonicalCell", () => {
  it("matches a unitPrice issue to the rate cell, not the qty cell", () => {
    const idx = buildExtractionIndex(SAMPLE_RUN);
    const line0 = idx.lineIssues(0);
    expect(issuesForCanonicalCell(line0, "rate").some((x) => x.code === "price_zero")).toBe(true);
    expect(issuesForCanonicalCell(line0, "qty").length).toBe(0);
  });
});

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
