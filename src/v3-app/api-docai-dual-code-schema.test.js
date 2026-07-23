// PO extraction must capture DUAL codes per line — the buyer's SAP/item code
// AND our own part number — and must know to parse the part OUT of the
// description when the Part-No column is blank or prefixed. Real Mahindra POs:
// ETC1 leaves Part-No blank (part = first line of Description); GEP/Ariba
// prints a SAP "Item Number" column AND buries our part behind a prefix
// ("OBARA STD SHANK TWS-092-90-2"). These assert the schema + prompt now
// encode that, provider-agnostically (claude is the source of truth; gemini is
// kept in lockstep per gemini.js:127).

import { describe, it, expect } from "vitest";
import { TOOL_DEFINITION, SYSTEM_PROMPT } from "../api/_lib/docai/claude.js";

const lineProps = TOOL_DEFINITION.input_schema.properties.lines.items.properties;
const prompt = String(SYSTEM_PROMPT);

describe("dual-code line schema", () => {
  it("carries the buyer SAP code AND our part AND the raw description as distinct fields", () => {
    expect(lineProps).toHaveProperty("partNumber");        // ours
    expect(lineProps).toHaveProperty("customerItemCode");  // buyer SAP/item code
    expect(lineProps).toHaveProperty("raw_description");   // verbatim audit source
    // still additive — the existing fields survive
    expect(lineProps).toHaveProperty("description");
    expect(lineProps).toHaveProperty("specification");
  });

  it("documents customerItemCode as the buyer's code, distinct from our part", () => {
    expect(String(lineProps.customerItemCode.description)).toMatch(/buyer/i);
    expect(String(lineProps.customerItemCode.description).toLowerCase()).toContain("distinct");
  });
});

describe("part-location prompt rules", () => {
  it("tells the model to parse the part from the description when the column is blank", () => {
    expect(prompt.toLowerCase()).toMatch(/part-?no column|part no column|column is blank|blank/);
    expect(prompt.toLowerCase()).toContain("description");
  });
  it("tells the model to strip a descriptive prefix (<BRAND> <GRADE> <NOUN> <CODE> -> the code)", () => {
    // The worked example must stay SYNTHETIC: a real seller's part format here
    // biases extraction toward that one tenant's catalogue.
    expect(prompt).toMatch(/AB-1042-7/);      // the worked example
    expect(prompt.toLowerCase()).toContain("prefix");
  });
  it("no longer hard-anchors the part to column 2 as the only pattern", () => {
    // the col-2 layout must be explicitly scoped as ONE example only
    expect(prompt.toLowerCase()).toMatch(/one example layout only|do not assume the part is in column 2/);
  });
  it("names customerItemCode + raw_description in the field guidance", () => {
    expect(prompt).toContain("customerItemCode");
    expect(prompt).toContain("raw_description");
  });
});
