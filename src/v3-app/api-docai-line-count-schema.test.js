// CM P3: the extractor must capture the PO's OWN declared line count
// (stated_line_count) so the line_count_shortfall completeness detector
// has a baseline to compare lines.length against — the fix for the
// silent "6 of 190 lines extracted" failure. claude is the source of
// truth; gemini is kept in lockstep.

import { describe, it, expect } from "vitest";
import { TOOL_DEFINITION, SYSTEM_PROMPT, coerceStatedLineCount } from "../api/_lib/docai/claude.js";

const topProps = TOOL_DEFINITION.input_schema.properties;
const prompt = String(SYSTEM_PROMPT);

describe("stated_line_count schema", () => {
  it("exposes stated_line_count as a top-level integer field", () => {
    expect(topProps).toHaveProperty("stated_line_count");
    expect(topProps.stated_line_count.type).toContain("integer");
    expect(topProps.stated_line_count.type).toContain("null");
  });

  it("documents it as the PO's DECLARED count, independent of returned lines", () => {
    const d = String(topProps.stated_line_count.description).toLowerCase();
    expect(d).toMatch(/declare|total|highest|serial/);
    expect(d).toMatch(/independent|never just count/);
  });

  it("does NOT force the field in required (a PO may print no total)", () => {
    expect(TOOL_DEFINITION.input_schema.required).not.toContain("stated_line_count");
  });

  it("tells the model to report the declared count even when it exceeds extracted lines", () => {
    expect(prompt).toMatch(/stated_line_count/);
    expect(prompt.toLowerCase()).toMatch(/highest.*(s\.no|serial)|exceeds the number|gap is a signal/);
  });
});

describe("coerceStatedLineCount", () => {
  it("keeps a positive integer", () => {
    expect(coerceStatedLineCount(190)).toBe(190);
  });
  it("rounds a float", () => {
    expect(coerceStatedLineCount(12.4)).toBe(12);
  });
  it("parses a numeric string", () => {
    expect(coerceStatedLineCount("32")).toBe(32);
  });
  it("rejects zero / negative / NaN / null as null", () => {
    expect(coerceStatedLineCount(0)).toBeNull();
    expect(coerceStatedLineCount(-3)).toBeNull();
    expect(coerceStatedLineCount("abc")).toBeNull();
    expect(coerceStatedLineCount(null)).toBeNull();
    expect(coerceStatedLineCount(undefined)).toBeNull();
  });
});
