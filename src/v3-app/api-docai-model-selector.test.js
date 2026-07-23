// Deterministic model selector tests.
//
// Each rule emits a unique reason string; we drive the pure
// function with synthetic context and assert the (model, tier,
// reason) tuple matches the rule we expect to fire.
//
// Selection priority (highest first):
//   1. tenant pin
//   2. escalate flag
//   3. heavy invoice (kind=invoice, lineCount >= threshold)
//   4. ocr-derived text
//   5. long document
//   6. supplier_ack / eway_bill stay on preflight
//   7. default cost-optimised (preflight)

import { describe, it, expect } from "vitest";
import { selectClaudeModel, selectGeminiModel, selectModelForProvider, shouldEscalateEmptyLines, __consts__ } from "../api/_lib/docai/model_selector.js";

describe("selectClaudeModel / priority order", () => {
  it("tenant pin wins over every rule", () => {
    const out = selectClaudeModel({
      kind: "invoice",
      lineCount: 50,                                    // would normally trigger invoice_many_lines
      ocrLayer: { status: "ok" },                       // would trigger ocr_derived_text
      textLayer: { char_count: 80_000 },                // would trigger long_document
      escalate: true,                                   // would trigger escalate_quality
      settings: { docai_anthropic_model: "claude-haiku-4-5-20251001" },
    });
    expect(out.tier).toBe("tenant_pinned");
    expect(out.reason).toBe("tenant_pinned");
    expect(out.model).toBe("claude-haiku-4-5-20251001");
  });

  it("trims whitespace on the tenant pin", () => {
    const out = selectClaudeModel({
      kind: "po",
      settings: { docai_anthropic_model: "  claude-haiku-4-5-20251001  " },
    });
    expect(out.model).toBe("claude-haiku-4-5-20251001");
  });

  it("ignores empty-string pin and falls through to rules", () => {
    const out = selectClaudeModel({
      kind: "po",
      settings: { docai_anthropic_model: "" },
    });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("default_cost_optimised");
  });

  it("escalate flag bumps to generation tier", () => {
    const out = selectClaudeModel({ kind: "po", escalate: true, settings: {} });
    expect(out.tier).toBe("generation");
    expect(out.reason).toBe("escalate_quality");
  });
});

describe("selectClaudeModel / context rules", () => {
  it("invoice with many lines bumps to generation", () => {
    const out = selectClaudeModel({
      kind: "invoice",
      lineCount: __consts__.HEAVY_INVOICE_LINE_THRESHOLD,
      settings: {},
    });
    expect(out.reason).toBe("invoice_many_lines");
    expect(out.tier).toBe("generation");
  });

  it("invoice with few lines stays on preflight", () => {
    const out = selectClaudeModel({
      kind: "invoice",
      lineCount: 5,
      settings: {},
    });
    expect(out.tier).toBe("preflight");
  });

  it("OCR-derived text bumps to generation", () => {
    const out = selectClaudeModel({
      kind: "po",
      ocrLayer: { status: "ok", char_count: 4000 },
      settings: {},
    });
    expect(out.reason).toBe("ocr_derived_text");
    expect(out.tier).toBe("generation");
  });

  it("OCR with status=partial also bumps", () => {
    const out = selectClaudeModel({
      kind: "po",
      ocrLayer: { status: "partial" },
      settings: {},
    });
    expect(out.reason).toBe("ocr_derived_text");
  });

  it("long doc bumps to generation", () => {
    const out = selectClaudeModel({
      kind: "po",
      textLayer: { char_count: __consts__.LONG_DOC_CHAR_THRESHOLD + 1 },
      settings: {},
    });
    expect(out.reason).toBe("long_document");
    expect(out.tier).toBe("generation");
  });

  it("supplier_ack stays on preflight (cheap)", () => {
    const out = selectClaudeModel({ kind: "supplier_ack", settings: {} });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("supplier_ack_short");
  });

  it("eway_bill stays on preflight (cheap)", () => {
    const out = selectClaudeModel({ kind: "eway_bill", settings: {} });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("eway_bill_structured");
  });

  it("supplier_ack with OCR-derived text bumps to generation (OCR rule wins over kind)", () => {
    const out = selectClaudeModel({
      kind: "supplier_ack",
      ocrLayer: { status: "ok" },
      settings: {},
    });
    expect(out.reason).toBe("ocr_derived_text");
  });

  it("default for clean text PO is preflight (cheapest)", () => {
    const out = selectClaudeModel({
      kind: "po",
      textLayer: { char_count: 4000, status: "has_text" },
      settings: {},
    });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("default_cost_optimised");
  });

  it("uses knownFields.lines as a lineCount fallback for heavy invoices", () => {
    const out = selectClaudeModel({
      kind: "invoice",
      knownFields: { lines: new Array(__consts__.HEAVY_INVOICE_LINE_THRESHOLD).fill({}) },
      settings: {},
    });
    expect(out.reason).toBe("invoice_many_lines");
  });
});

describe("selectGeminiModel / priority order", () => {
  it("tenant pin wins over every rule", () => {
    const out = selectGeminiModel({
      escalate: true,
      ocrLayer: { status: "ok" },
      settings: { docai_gemini_model: "gemini-2.5-pro" },
    });
    expect(out.reason).toBe("tenant_pinned");
    expect(out.model).toBe("gemini-2.5-pro");
  });

  it("escalate bumps to reasoning tier", () => {
    const out = selectGeminiModel({ kind: "po", escalate: true, settings: {} });
    expect(out.tier).toBe("reasoning");
    expect(out.reason).toBe("escalate_quality");
  });

  it("OCR-derived text bumps to reasoning tier", () => {
    const out = selectGeminiModel({
      kind: "po",
      ocrLayer: { status: "ok" },
      settings: {},
    });
    expect(out.tier).toBe("reasoning");
    expect(out.reason).toBe("ocr_derived_text");
  });

  it("very long doc bumps to reasoning tier (>100K chars)", () => {
    const out = selectGeminiModel({
      kind: "po",
      textLayer: { char_count: __consts__.VERY_LONG_DOC_CHAR_THRESHOLD + 1 },
      settings: {},
    });
    expect(out.reason).toBe("very_long_document");
  });

  it("default for clean PO is preflight (free tier)", () => {
    const out = selectGeminiModel({
      kind: "po",
      textLayer: { char_count: 4000 },
      settings: {},
    });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("default_cost_optimised");
  });
});

describe("selectModelForProvider", () => {
  it("dispatches to claude when provider='claude'", () => {
    const out = selectModelForProvider("claude", { kind: "po", settings: {} });
    expect(out.tier).toBe("preflight");
  });

  it("dispatches to gemini when provider='gemini'", () => {
    const out = selectModelForProvider("gemini", { kind: "po", settings: {} });
    expect(out.tier).toBe("preflight");
  });

  it("returns unknown_provider for unsupported providers", () => {
    const out = selectModelForProvider("openai", { kind: "po", settings: {} });
    expect(out.reason).toBe("unknown_provider");
    expect(out.model).toBeNull();
  });
});

describe("selectClaudeModel / multi-page PO rule (Mahindra empty-lines fix)", () => {
  it("bumps a multi-page PO to the generation tier up front", () => {
    const out = selectClaudeModel({
      kind: "po",
      textLayer: { char_count: 4000, page_count: 13, status: "has_text" },
      settings: {},
    });
    expect(out.tier).toBe("generation");
    expect(out.reason).toBe("po_multipage");
  });

  it("uses the OCR-layer page count as a fallback when OCR didn't feed the prompt", () => {
    const out = selectClaudeModel({
      kind: "rfq",
      ocrLayer: { status: "skipped", page_count: 6 },
      settings: {},
    });
    expect(out.tier).toBe("generation");
    expect(out.reason).toBe("po_multipage");
  });

  it("keeps a short single-page PO on the cheap tier", () => {
    const out = selectClaudeModel({
      kind: "po",
      textLayer: { char_count: 4000, page_count: 2, status: "has_text" },
      settings: {},
    });
    expect(out.tier).toBe("preflight");
    expect(out.reason).toBe("default_cost_optimised");
  });

  it("does not apply the multi-page rule to non-PO kinds", () => {
    const out = selectClaudeModel({
      kind: "supplier_ack",
      textLayer: { char_count: 4000, page_count: 13, status: "has_text" },
      settings: {},
    });
    expect(out.reason).toBe("supplier_ack_short");
  });

  it("gemini also bumps multi-page POs to the reasoning tier", () => {
    const out = selectGeminiModel({
      kind: "po",
      textLayer: { char_count: 4000, page_count: 13 },
      settings: {},
    });
    expect(out.tier).toBe("reasoning");
    expect(out.reason).toBe("po_multipage");
  });
});

describe("shouldEscalateEmptyLines / reactive retry predicate", () => {
  const emptyPoOut = {
    ok: true,
    selected_model: "claude-haiku-4-5-20251001",
    model_selection_reason: "default_cost_optimised",
    normalized: { classification: "po", customer: { name: "MAHINDRA & MAHINDRA LTD" }, lines: [], stated_line_count: 45 },
  };

  it("fires for a cheap-tier PO that returned a header but zero lines", () => {
    expect(shouldEscalateEmptyLines({ out: emptyPoOut, kind: "po", settings: {} })).toBe(true);
  });

  it("does NOT fire when lines were extracted", () => {
    const out = { ...emptyPoOut, normalized: { ...emptyPoOut.normalized, lines: [{ description: "x" }] } };
    expect(shouldEscalateEmptyLines({ out, kind: "po", settings: {} })).toBe(false);
  });

  it("does NOT fire when the model already used the generation tier (nothing to escalate to)", () => {
    const out = { ...emptyPoOut, model_selection_reason: "po_multipage" };
    expect(shouldEscalateEmptyLines({ out, kind: "po", settings: {} })).toBe(false);
  });

  it("does NOT fire on a genuine non-PO (no wasted second call)", () => {
    const out = { ...emptyPoOut, normalized: { ...emptyPoOut.normalized, classification: "non_po" } };
    expect(shouldEscalateEmptyLines({ out, kind: "po", settings: {} })).toBe(false);
  });

  it("does NOT fire when the model never engaged (no customer header)", () => {
    const out = { ...emptyPoOut, normalized: { ...emptyPoOut.normalized, customer: null } };
    expect(shouldEscalateEmptyLines({ out, kind: "po", settings: {} })).toBe(false);
  });

  it("does NOT fire on a failed extraction", () => {
    expect(shouldEscalateEmptyLines({ out: { ok: false }, kind: "po", settings: {} })).toBe(false);
  });

  it("respects the docai_empty_lines_escalation=false opt-out", () => {
    expect(shouldEscalateEmptyLines({ out: emptyPoOut, kind: "po", settings: { docai_empty_lines_escalation: false } })).toBe(false);
  });

  it("only applies to po/rfq kinds", () => {
    expect(shouldEscalateEmptyLines({ out: emptyPoOut, kind: "invoice", settings: {} })).toBe(false);
  });
});
