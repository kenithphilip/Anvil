// CM PDM P3a: the part-drawing extractor. The individual CHILD-part drawing is
// SUPPLIER-ONLY (never shared with the customer) and carries the manufacturing
// spec — material, finish, heat treatment, tolerances, GD&T — that a supplier
// needs to MAKE the part. It's a new DocAI document KIND that slots in exactly
// like assembly_bom: a distinct schema + prompt on the SAME two adapters. claude
// is the source of truth; gemini is kept in lockstep.

import { describe, it, expect } from "vitest";
import {
  PART_DRAWING_TOOL,
  PART_DRAWING_SYSTEM_PROMPT,
  normalizePartDrawing as claudeNormalize,
} from "../api/_lib/docai/claude.js";
import {
  PART_DRAWING_SCHEMA,
  normalizePartDrawing as geminiNormalize,
} from "../api/_lib/docai/gemini.js";
import { rawMaterialFromPartSpec } from "../api/_lib/pdm/raw-material-infer.js";

const props = PART_DRAWING_TOOL.input_schema.properties;

describe("part_drawing tool schema (claude, source of truth)", () => {
  it("classifies part_drawing vs non_drawing", () => {
    expect(props.classification.enum).toEqual(["part_drawing", "non_drawing"]);
  });

  it("captures the title block with the part's own part_no", () => {
    const tb = props.title_block.properties;
    for (const f of ["drawing_no", "part_no", "revision", "title", "sheet", "scale"]) {
      expect(tb).toHaveProperty(f);
    }
  });

  it("captures the manufacturing spec — material, finish, heat treatment", () => {
    for (const f of ["material", "finish", "heat_treatment"]) {
      expect(props).toHaveProperty(f);
      expect(props[f].type).toContain("null");
    }
  });

  it("captures toleranced dimensions + GD&T callouts as arrays", () => {
    expect(props.tolerances.type).toBe("array");
    for (const f of ["feature", "nominal", "tolerance"]) expect(props.tolerances.items.properties).toHaveProperty(f);
    expect(props.gdt.type).toBe("array");
    for (const f of ["symbol", "tolerance", "datum"]) expect(props.gdt.items.properties).toHaveProperty(f);
    expect(props.notes.type).toBe("array");
  });

  it("has NO parts list (a part drawing is one part, not a BOM)", () => {
    expect(props).not.toHaveProperty("lines");
    expect(props).not.toHaveProperty("stated_line_count");
  });

  it("requires only classification + confidence", () => {
    expect(PART_DRAWING_TOOL.input_schema.required).toEqual(["classification", "confidence"]);
  });
});

describe("part_drawing prompt", () => {
  const p = String(PART_DRAWING_SYSTEM_PROMPT).toLowerCase();
  it("frames it as a single part, supplier-facing manufacturing spec", () => {
    expect(p).toMatch(/single/);
    expect(p).toMatch(/material/);
    expect(p).toMatch(/gd&t|tolerance/);
    expect(p).toMatch(/no parts list/);
  });
  it("classifies an assembly-with-parts-list as non_drawing", () => {
    expect(p).toMatch(/non_drawing/);
    expect(p).toMatch(/assembly/);
  });
});

describe("normalizePartDrawing (claude)", () => {
  const out = claudeNormalize({
    classification: "part_drawing",
    confidence: 0.9,
    title_block: { drawing_no: "PD-500", part_no: "SHANK-A", revision: "C", title: "Weld shank" },
    material: "EN8",
    finish: "hard chrome 20 micron",
    heat_treatment: "harden & temper 45-50 HRC",
    tolerances: [{ feature: "bore dia", nominal: 25, tolerance: "H7" }],
    gdt: [{ symbol: "position", tolerance: 0.1, datum: "A-B" }],
    notes: ["deburr all edges", ""],
  });

  it("keeps the part identity + manufacturing spec under part_spec", () => {
    expect(out.classification).toBe("part_drawing");
    expect(out.part_spec.title_block).toMatchObject({ drawing_no: "PD-500", part_no: "SHANK-A", revision: "C" });
    expect(out.part_spec).toMatchObject({ material: "EN8", finish: "hard chrome 20 micron", heat_treatment: "harden & temper 45-50 HRC" });
  });

  it("coerces tolerance/GD&T numerics to strings + drops blank notes", () => {
    expect(out.part_spec.tolerances[0]).toEqual({ feature: "bore dia", nominal: "25", tolerance: "H7" });
    expect(out.part_spec.gdt[0]).toEqual({ symbol: "position", tolerance: "0.1", datum: "A-B" });
    expect(out.part_spec.notes).toEqual(["deburr all edges"]);
  });

  it("emits an empty lines[] so the anomaly/validator passes stay safe", () => {
    expect(out.lines).toEqual([]);
  });

  it("handles a bare / non_drawing input without throwing", () => {
    expect(claudeNormalize({ classification: "non_drawing" }).part_spec.tolerances).toEqual([]);
    expect(claudeNormalize(null).lines).toEqual([]);
  });
});

describe("gemini stays in lockstep with claude", () => {
  it("exposes the same top-level schema fields", () => {
    const g = PART_DRAWING_SCHEMA.properties;
    for (const f of Object.keys(props)) expect(g).toHaveProperty(f);
    expect(g.classification.enum).toEqual(props.classification.enum);
    expect(PART_DRAWING_SCHEMA.required).toEqual(PART_DRAWING_TOOL.input_schema.required);
  });

  it("normalizes identically to claude", () => {
    const input = {
      classification: "part_drawing",
      confidence: 0.8,
      title_block: { drawing_no: "D-1", part_no: "P-1" },
      material: "SS304",
      dimensions: { diameter: "Ø25", length: "110 mm" },
      bought_out: false,
      tolerances: [{ feature: "od", nominal: 10, tolerance: "g6" }],
      gdt: [], notes: ["note"],
    };
    expect(geminiNormalize(input)).toEqual(claudeNormalize(input));
  });
});

// Slice B: the extraction now captures the raw-stock envelope + a make/buy flag.
describe("part_drawing dimensions + bought_out (Slice B)", () => {
  it("schema exposes a dimensions envelope + bought_out", () => {
    expect(props.dimensions.properties).toMatchObject({
      diameter: expect.anything(), length: expect.anything(), width: expect.anything(), height: expect.anything(), thickness: expect.anything(),
    });
    expect(props.bought_out.type).toContain("boolean");
    expect(String(PART_DRAWING_SYSTEM_PROMPT).toLowerCase()).toMatch(/dimension|envelope|diameter/);
    expect(String(PART_DRAWING_SYSTEM_PROMPT).toLowerCase()).toMatch(/bought.?out|purchased|standard/);
  });

  it("normalize coerces the envelope to positive numbers (mm) + a boolean bought_out", () => {
    const out = claudeNormalize({
      classification: "part_drawing", confidence: 0.9,
      title_block: { part_no: "SHANK-A", title: "Weld shank" },
      material: "CrCu",
      dimensions: { diameter: "Ø25", length: "110 mm", width: null, height: "0", thickness: "abc" },
      bought_out: null,
    });
    expect(out.part_spec.dimensions).toEqual({ diameter: 25, length: 110, width: null, height: null, thickness: null });
    expect(out.part_spec.bought_out).toBe(false); // null -> false
  });

  it("nulls the dimensions object when nothing numeric was read", () => {
    const out = claudeNormalize({ classification: "part_drawing", confidence: 0.5, dimensions: { diameter: "n/a" } });
    expect(out.part_spec.dimensions).toBeNull();
  });
});

// The bridge: extraction -> the raw-material determination engine, with the gate.
describe("rawMaterialFromPartSpec (extraction -> engine)", () => {
  it("a machined part_spec (material + dims) yields a make recipe with stock size", () => {
    const out = claudeNormalize({
      classification: "part_drawing", confidence: 0.9,
      title_block: { part_no: "SHANK-A", title: "Weld gun shank" },
      material: "CrCu", dimensions: { diameter: "25", length: "110" }, bought_out: false,
    });
    const v = rawMaterialFromPartSpec(out.part_spec, { allowanceMm: 3 });
    expect(v.procurement_type).toBe("make");
    expect(v.recipe).toMatchObject({ material: "CuCrZr", form: "rod" });
    expect(v.recipe.stock_dims).toEqual({ diameter: 31, length: 113 });
  });

  it("a part_spec flagged bought_out returns NO recipe (the gate holds through the bridge)", () => {
    const out = claudeNormalize({
      classification: "part_drawing", confidence: 0.9,
      title_block: { part_no: "BRG-6204", title: "Ball bearing" },
      material: "SS304", dimensions: { diameter: "20", length: "14" }, bought_out: true,
    });
    const v = rawMaterialFromPartSpec(out.part_spec);
    expect(v.procurement_type).toBe("buy");
    expect(v.recipe).toBeNull();
  });
});
