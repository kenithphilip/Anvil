// LlamaParse adapter (issue #210) — pure mapping + gating. No network:
// the async upload/poll flow is verified against the live API on activation.

import { describe, it, expect, afterEach } from "vitest";
import * as llamaparse from "../api/_lib/docai/llamaparse.js";

const { parseMarkdownTable, normalizeFromMarkdown, tierMode, TIER_MODE } = llamaparse.__test__;

afterEach(() => { delete process.env.LLAMA_CLOUD_API_KEY; });

describe("llamaparse adapter — gating (OFF by default)", () => {
  it("isConfigured is false with no tenant key and no env key", () => {
    expect(llamaparse.isConfigured({})).toBe(false);
    expect(llamaparse.isConfigured(null)).toBe(false);
  });
  it("isConfigured is true when the LLAMA_CLOUD_API_KEY env is set", () => {
    process.env.LLAMA_CLOUD_API_KEY = "llx-test";
    expect(llamaparse.isConfigured({})).toBe(true);
  });
});

describe("llamaparse adapter — tier mapping", () => {
  it("maps each tier to a parse_mode; defaults to cost_effective", () => {
    expect(tierMode({ docai_llamaparse_tier: "fast" })).toBe(TIER_MODE.fast);
    expect(tierMode({ docai_llamaparse_tier: "agentic" })).toBe(TIER_MODE.agentic);
    expect(tierMode({})).toBe(TIER_MODE.cost_effective);
    expect(tierMode({ docai_llamaparse_tier: "bogus" })).toBe(TIER_MODE.cost_effective);
  });
});

describe("llamaparse adapter — markdown table -> line items", () => {
  const md = [
    "Some preamble text",
    "| Part No | Description | HSN | Qty | Unit Price |",
    "|---------|-------------|-----|-----|-----------|",
    "| 403A7K188-100 | Point Holder | 85159000 | 2 | 27,244.00 |",
    "| 303S1002KS | Shunt | 85159000 | 5 | 16,640.40 |",
    "",
    "Total ...",
  ].join("\n");

  it("parseMarkdownTable strips separators and splits cells", () => {
    const rows = parseMarkdownTable(md);
    expect(rows[0]).toEqual(["Part No", "Description", "HSN", "Qty", "Unit Price"]);
    expect(rows.length).toBe(3); // header + 2 data rows (separator dropped)
  });

  it("normalizeFromMarkdown maps columns onto line items", () => {
    const { lines } = normalizeFromMarkdown(md);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ partNumber: "403A7K188-100", description: "Point Holder", hsn: "85159000", quantity: 2, unitPrice: 27244 });
    expect(lines[1].partNumber).toBe("303S1002KS");
    expect(lines[1].quantity).toBe(5);
  });

  it("returns no lines for markdown without a table", () => {
    expect(normalizeFromMarkdown("just prose, no table").lines).toEqual([]);
  });
});
