// CM PDM P1a: the assembly-BOM drawing extractor. The gun/asset ASSEMBLY
// drawing (the only drawing shared with the customer) carries a title block +
// a parts-list keyed by the drawing's BALLOON number. This is a new DocAI
// document KIND that slots in exactly like supplier_ack: a distinct schema +
// prompt on the SAME two LLM adapters. claude is the source of truth; gemini
// is kept in lockstep so the voter can cross-check.

import { describe, it, expect } from "vitest";
import {
  ASSEMBLY_BOM_TOOL,
  ASSEMBLY_BOM_SYSTEM_PROMPT,
  normalizeAssemblyBom as claudeNormalize,
} from "../api/_lib/docai/claude.js";
import {
  ASSEMBLY_BOM_SCHEMA,
  normalizeAssemblyBom as geminiNormalize,
} from "../api/_lib/docai/gemini.js";

const props = ASSEMBLY_BOM_TOOL.input_schema.properties;
const lineProps = props.lines.items.properties;

describe("assembly_bom tool schema (claude, source of truth)", () => {
  it("classifies assembly_bom vs non_drawing", () => {
    expect(props.classification.enum).toEqual(["assembly_bom", "non_drawing"]);
  });

  it("captures the title block with drawing_no + revision + asset_code", () => {
    const tb = props.title_block.properties;
    for (const f of ["drawing_no", "revision", "asset_code", "title", "material", "sheet", "scale"]) {
      expect(tb).toHaveProperty(f);
      expect(tb[f].type).toContain("null"); // every title-block field is optional
    }
    // asset_code is the assembly's OWN part no — the top-level identity.
    expect(props.title_block.type).toContain("object");
  });

  it("captures each parts-list row keyed by balloon_no + part_number + quantity", () => {
    for (const f of ["balloon_no", "part_number", "description", "quantity", "material", "is_spare"]) {
      expect(lineProps).toHaveProperty(f);
    }
    expect(lineProps.balloon_no.type).toContain("string"); // verbatim ('10A')
    expect(lineProps.quantity.type).toContain("number");
    expect(lineProps.is_spare.type).toContain("boolean");
  });

  it("captures a bought_out flag per row (Slice B: for the make/buy gate)", () => {
    expect(lineProps.bought_out.type).toContain("boolean");
    const out = claudeNormalize({
      classification: "assembly_bom", confidence: 0.9,
      lines: [{ balloon_no: "1", part_number: "P1", quantity: 1, bought_out: true }],
    });
    expect(out.lines[0].bought_out).toBe(true);
  });

  it("carries stated_line_count so the completeness gate can catch dropped rows", () => {
    expect(props.stated_line_count.type).toContain("integer");
    expect(props.stated_line_count.type).toContain("null");
  });

  it("requires only classification + confidence + lines", () => {
    expect(ASSEMBLY_BOM_TOOL.input_schema.required).toEqual(["classification", "confidence", "lines"]);
  });
});

describe("assembly_bom prompt", () => {
  const p = String(ASSEMBLY_BOM_SYSTEM_PROMPT).toLowerCase();
  it("instructs the balloon number as the customer-facing spare identity", () => {
    expect(p).toMatch(/balloon/);
    expect(p).toMatch(/parts.list|bom table|item table/);
  });
  it("guards against dropping rows + declares stated_line_count from the highest item no", () => {
    expect(p).toMatch(/do not drop rows|complete/);
    expect(p).toMatch(/highest.*(item|balloon).*number/);
    expect(p).toMatch(/never just count your own output/);
  });
  it("tells the model to classify non_drawing and stop", () => {
    expect(p).toMatch(/non_drawing/);
  });
});

describe("normalizeAssemblyBom (claude)", () => {
  const out = claudeNormalize({
    classification: "assembly_bom",
    confidence: 0.9,
    title_block: { drawing_no: "GA-1234", revision: "B", asset_code: "GUN-77", title: "Weld Gun", sheet: "1 of 2" },
    lines: [
      { balloon_no: 1, part_number: "SHANK-A", description: "Shank", quantity: 2, material: "EN8", is_spare: true },
      { balloon_no: "10A", part_number: "TIP-9", description: "Electrode tip", quantity: 4, is_spare: false },
    ],
    stated_line_count: 12,
  });

  it("preserves the title block + asset_code identity", () => {
    expect(out.title_block).toMatchObject({ drawing_no: "GA-1234", revision: "B", asset_code: "GUN-77" });
  });

  it("maps rows to the PO-normalized line shape (partNumber/quantity) + drawing fields", () => {
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({
      balloon_no: "1", partNumber: "SHANK-A", quantity: 2, material: "EN8", is_spare: true, unitPrice: null,
    });
    // balloon_no is coerced to string so '1' and '10A' share one type.
    expect(out.lines[0].balloon_no).toBe("1");
    expect(out.lines[1].balloon_no).toBe("10A");
  });

  it("carries the declared count so a 12-declared / 2-extracted parts list is catchable", () => {
    expect(out.stated_line_count).toBe(12);
    expect(out.lines.length).toBeLessThan(out.stated_line_count); // the shortfall the gate fires on
  });

  it("preserves a non_drawing classification with empty lines", () => {
    const nd = claudeNormalize({ classification: "non_drawing", lines: [] });
    expect(nd.classification).toBe("non_drawing");
    expect(nd.lines).toEqual([]);
  });
});

describe("gemini stays in lockstep with claude", () => {
  it("exposes the same top-level schema fields", () => {
    const g = ASSEMBLY_BOM_SCHEMA.properties;
    for (const f of Object.keys(props)) expect(g).toHaveProperty(f);
    expect(g.classification.enum).toEqual(props.classification.enum);
    expect(ASSEMBLY_BOM_SCHEMA.required).toEqual(ASSEMBLY_BOM_TOOL.input_schema.required);
  });

  it("normalizes identically to claude", () => {
    const input = {
      classification: "assembly_bom",
      confidence: 0.8,
      title_block: { drawing_no: "D-1", asset_code: "A-1" },
      lines: [{ balloon_no: 5, part_number: "P-5", quantity: 3, is_spare: null }],
      stated_line_count: 5,
    };
    expect(geminiNormalize(input)).toEqual(claudeNormalize(input));
  });
});
