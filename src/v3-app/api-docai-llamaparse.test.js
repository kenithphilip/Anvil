// LlamaParse adapter (issue #210) — plug-and-play, env-keyed like
// claude/gemini. Pure mapping + gating tests, PLUS a mocked-SDK test of the
// extract() call shape (which caught the real "expand: markdown_full" bug that
// made every live run 422 -> llamaparse:failed).

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import * as llamaparse from "../api/_lib/docai/llamaparse.js";
import { encryptField, newIv } from "../api/_lib/secrets.js";

const { parseMarkdownTable, normalizeFromMarkdown, scoreConfidence, markdownOf, tier } = llamaparse.__test__;

beforeAll(() => { process.env.ANVIL_SECRETS_KEY = "0".repeat(64); });   // for the encrypted-key test
afterEach(() => {
  delete process.env.LLAMA_CLOUD_API_KEY;
  delete process.env.LLAMAPARSE_API_KEY;
  delete process.env.LLAMAPARSE_TIER;
});

describe("llamaparse adapter — gating (per-tenant key first, then env)", () => {
  it("isConfigured is false with no key set", () => {
    expect(llamaparse.isConfigured({})).toBe(false);
    expect(llamaparse.isConfigured(null)).toBe(false);
  });
  it("isConfigured is true when LLAMAPARSE_API_KEY is set (the deployed var)", () => {
    process.env.LLAMAPARSE_API_KEY = "llx-test";
    expect(llamaparse.isConfigured({})).toBe(true);
  });
  it("isConfigured falls back to LLAMA_CLOUD_API_KEY (legacy configs)", () => {
    process.env.LLAMA_CLOUD_API_KEY = "legacy";
    expect(llamaparse.isConfigured({})).toBe(true);
  });
  it("reads the per-tenant encrypted key (docai_llamacloud_api_key_enc) first, no env needed (#210)", () => {
    const iv = newIv();
    const settings = { docai_llamacloud_api_key_enc: encryptField("llx-tenant", iv), docai_creds_iv: iv };
    expect(llamaparse.isConfigured(settings)).toBe(true);            // env unset
    expect(llamaparse.__test__.apiKey(settings)).toBe("llx-tenant"); // decrypts the tenant key
  });
  it("extract fails soft when no key is set", async () => {
    const r = await llamaparse.extract({ bytes: Buffer.from("x") });
    expect(r.ok).toBe(false);
  });
});

describe("llamaparse adapter — confidence must clear the 0.85 fallback threshold", () => {
  // Old code hardcoded 0.8, which sat permanently below the dispatcher's
  // default docai_fallback_confidence (0.85), so LlamaParse could never win
  // as the primary — the dispatcher always fell through to the next adapter.
  it("a complete line table scores ABOVE 0.85", () => {
    expect(scoreConfidence([{ partNumber: "A", quantity: 1 }, { partNumber: "B", quantity: 2 }])).toBeGreaterThan(0.85);
  });
  it("a table with no quantities stays BELOW 0.85 (chain falls through)", () => {
    expect(scoreConfidence([{ partNumber: "A", quantity: null }, { partNumber: "B", quantity: null }])).toBeLessThan(0.85);
  });
  it("no lines => low (0.4)", () => {
    expect(scoreConfidence([])).toBe(0.4);
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

describe("markdownOf — handle the SDK response shapes", () => {
  it("prefers the flat markdown_full string", () => {
    expect(markdownOf({ markdown_full: "| a |\n|---|\n| 1 |" })).toContain("| a |");
  });
  it("joins the structured markdown.pages[] when markdown_full is absent", () => {
    const r = { markdown: { pages: [{ markdown: "page1" }, { markdown: "page2" }] } };
    expect(markdownOf(r)).toBe("page1\n\npage2");
  });
  it("tolerates a loose top-level pages array + a string markdown", () => {
    expect(markdownOf({ pages: [{ md: "x" }] })).toBe("x");
    expect(markdownOf({ markdown: "flat" })).toBe("flat");
  });
  it("returns empty string on an empty result", () => {
    expect(markdownOf({})).toBe("");
  });
});

describe("extract() — SDK call shape (regression: expand must be 'markdown', not 'markdown_full')", () => {
  const MD = "| Part No | Qty | Unit Price |\n|---|---|---|\n| P-1 | 2 | 100 |";

  const mockSdk = (parseImpl) => {
    const parse = vi.fn(parseImpl);
    vi.doMock("@llamaindex/llama-cloud", () => ({
      default: class { constructor() { this.parsing = { parse }; } },
      toFile: async (b, n, o) => ({ name: n, type: o?.type, bytes: b }),
    }));
    return parse;
  };

  afterEach(() => { vi.resetModules(); vi.doUnmock("@llamaindex/llama-cloud"); delete process.env.LLAMAPARSE_API_KEY; });

  it("calls parsing.parse with expand:['markdown'] and maps result.markdown_full -> lines", async () => {
    process.env.LLAMAPARSE_API_KEY = "llx-test";
    const parse = mockSdk(async () => ({ markdown_full: MD, job: { id: "job-1" } }));
    const { extract } = await import("../api/_lib/docai/llamaparse.js");
    const out = await extract({ bytes: Buffer.from("%PDF-1.4"), filename: "po.pdf", mime: "application/pdf" });

    expect(parse).toHaveBeenCalledTimes(1);
    const args = parse.mock.calls[0][0];
    expect(args.expand).toEqual(["markdown"]);          // NOT ["markdown_full"] — the bug
    expect(args.upload_file).toBeTruthy();
    expect(out.ok).toBe(true);
    expect(out.normalized.lines).toHaveLength(1);
    expect(out.normalized.lines[0]).toMatchObject({ partNumber: "P-1", quantity: 2, unitPrice: 100 });
    expect(out.normalized.classification).toBe("po");
  });

  it("also maps the structured markdown.pages[] response shape", async () => {
    process.env.LLAMAPARSE_API_KEY = "llx-test";
    mockSdk(async () => ({ markdown: { pages: [{ markdown: MD }] } }));
    const { extract } = await import("../api/_lib/docai/llamaparse.js");
    const out = await extract({ bytes: Buffer.from("%PDF-1.4"), filename: "po.pdf", mime: "application/pdf" });
    expect(out.ok).toBe(true);
    expect(out.normalized.lines).toHaveLength(1);
  });

  it("fails soft (reason set) when the SDK throws", async () => {
    process.env.LLAMAPARSE_API_KEY = "llx-test";
    mockSdk(async () => { throw new Error("422 unprocessable: expand"); });
    const { extract } = await import("../api/_lib/docai/llamaparse.js");
    const out = await extract({ bytes: Buffer.from("%PDF-1.4"), filename: "po.pdf" });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("adapter_threw");
    expect(out.error).toContain("422");
  });
});
