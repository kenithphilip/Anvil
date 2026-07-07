// LlamaParse adapter (issue #210) — plug-and-play, env-keyed like
// claude/gemini. Pure mapping + gating tests (no network; the live SDK
// upload/parse flow is exercised against a real key on activation).

import { describe, it, expect, afterEach } from "vitest";
import * as llamaparse from "../api/_lib/docai/llamaparse.js";

const { parseMarkdownTable, normalizeFromMarkdown, tier } = llamaparse.__test__;

afterEach(() => { delete process.env.LLAMA_CLOUD_API_KEY; delete process.env.LLAMAPARSE_TIER; });

describe("llamaparse adapter — gating (off by default, env-keyed like claude)", () => {
  it("isConfigured is false with no LLAMA_CLOUD_API_KEY", () => {
    expect(llamaparse.isConfigured({})).toBe(false);
    expect(llamaparse.isConfigured(null)).toBe(false);
  });
  it("isConfigured is true only when LLAMA_CLOUD_API_KEY is set", () => {
    process.env.LLAMA_CLOUD_API_KEY = "llx-test";
    expect(llamaparse.isConfigured({})).toBe(true);
  });
  it("extract fails soft when no key is set", async () => {
    const r = await llamaparse.extract({ bytes: Buffer.from("x") });
    expect(r.ok).toBe(false);
  });
});

describe("llamaparse adapter — tier", () => {
  it("defaults to agentic; LLAMAPARSE_TIER overrides", () => {
    expect(tier()).toBe("agentic");
    process.env.LLAMAPARSE_TIER = "fast";
    expect(tier()).toBe("fast");
  });
});

describe("llamaparse adapter — markdown_full -> line items", () => {
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
    expect(rows.length).toBe(3);
  });

  it("normalizeFromMarkdown maps columns onto line items", () => {
    const { lines } = normalizeFromMarkdown(md);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ partNumber: "403A7K188-100", description: "Point Holder", hsn: "85159000", quantity: 2, unitPrice: 27244 });
    expect(lines[1].partNumber).toBe("303S1002KS");
  });

  it("returns no lines for markdown without a table", () => {
    expect(normalizeFromMarkdown("just prose, no table").lines).toEqual([]);
  });
});
