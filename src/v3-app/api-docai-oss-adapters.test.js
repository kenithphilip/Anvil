// Phase C: open-source adapter tests (Docling / Marker / Unstructured-OSS).
//
// We test the parts that don't make real HTTP calls:
//   - isConfigured() returns the right boolean for each settings shape
//   - Markdown table parsing handles the standard pipe-table grid
//     plus the alignment-row variant
//   - normalize() returns the canonical { customer, lines } shape
//     and skips non-line tables (summaries, blank tables)
//   - Endpoint resolution honours the precedence (settings > env >
//     default hosted URL).
//
// HTTP round-trips are integration tests against a real Docling /
// Marker / Unstructured server, not in this suite.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as docling from "../api/_lib/docai/docling.js";
import * as marker from "../api/_lib/docai/marker.js";
import * as unstructured from "../api/_lib/docai/unstructured.js";

const SAMPLE_MD_TABLE = `Some prose.

| Part No   | Description       | Qty | Unit Price |
|-----------|-------------------|-----|------------|
| BRG-6204  | Deep groove       | 100 | 125.00     |
| BRG-6205  | Deep groove       | 50  | 145.50     |

Subtotal: 25,275.00
`;

const SUMMARY_ONLY_MD = `
| Total | Amount |
|-------|--------|
| Sum   | 25275  |
`;

describe("docling / configuration", () => {
  let saved;
  beforeEach(() => { saved = process.env.DOCLING_ENDPOINT; });
  afterEach(() => { process.env.DOCLING_ENDPOINT = saved; });

  it("isConfigured = false when no endpoint and no env var", () => {
    delete process.env.DOCLING_ENDPOINT;
    expect(docling.isConfigured({})).toBe(false);
  });

  it("isConfigured = true when settings.docai_docling_endpoint is set", () => {
    expect(docling.isConfigured({ docai_docling_endpoint: "http://docling.local:5001" })).toBe(true);
  });

  it("isConfigured = true when DOCLING_ENDPOINT env var is set", () => {
    process.env.DOCLING_ENDPOINT = "http://docling.local:5001";
    expect(docling.isConfigured({})).toBe(true);
  });
});

describe("docling / table parsing", () => {
  it("parses a standard pipe-table into row arrays", () => {
    const rows = docling.__test__.parseMarkdownTable(`
| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | 6 |
`);
    expect(rows).toEqual([
      ["A", "B", "C"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("extracts a table from a markdown blob", () => {
    const tables = docling.__test__.extractTables(SAMPLE_MD_TABLE);
    expect(tables).toHaveLength(1);
    expect(tables[0][0]).toEqual(["Part No", "Description", "Qty", "Unit Price"]);
  });

  it("normalizes the canonical { customer, lines } shape", () => {
    const out = docling.__test__.normalizeFromDocling({ document: { md_content: SAMPLE_MD_TABLE } });
    expect(out.customer).toBeNull();
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({
      partNumber: "BRG-6204",
      description: "Deep groove",
      quantity: 100,
      unitPrice: 125,
    });
  });

  it("skips tables that don't look like line items (only 1 column match)", () => {
    const out = docling.__test__.normalizeFromDocling({ document: { md_content: SUMMARY_ONLY_MD } });
    expect(out.lines).toHaveLength(0);
  });
});

describe("marker / configuration", () => {
  it("isConfigured = true for self-hosted with endpoint set", () => {
    expect(marker.isConfigured({
      docai_marker_endpoint: "http://marker.local:8001",
      docai_marker_mode: "self_hosted",
    })).toBe(true);
  });

  it("isConfigured = true for datalab when API key is set, regardless of endpoint", () => {
    // The datalab path defaults the endpoint to https://www.datalab.to
    // so as long as a key is supplied via env, it's configured.
    const saved = process.env.MARKER_API_KEY;
    process.env.MARKER_API_KEY = "test-key";
    try {
      expect(marker.isConfigured({ docai_marker_mode: "datalab" })).toBe(true);
    } finally { process.env.MARKER_API_KEY = saved; }
  });

  it("isConfigured = false in datalab mode with no key", () => {
    const saved = process.env.MARKER_API_KEY;
    delete process.env.MARKER_API_KEY;
    try {
      expect(marker.isConfigured({ docai_marker_mode: "datalab" })).toBe(false);
    } finally { process.env.MARKER_API_KEY = saved; }
  });

  it("isConfigured = false in self_hosted mode with no endpoint", () => {
    const saved = process.env.MARKER_ENDPOINT;
    delete process.env.MARKER_ENDPOINT;
    try {
      expect(marker.isConfigured({ docai_marker_mode: "self_hosted" })).toBe(false);
    } finally { process.env.MARKER_ENDPOINT = saved; }
  });
});

describe("marker / response shape handling", () => {
  it("collects markdown from { markdown } shape", () => {
    expect(marker.__test__.collectMarkdown({ markdown: "hello" })).toBe("hello");
  });

  it("collects markdown from { result: [{ markdown }, ...] } shape", () => {
    expect(marker.__test__.collectMarkdown({
      result: [{ markdown: "p1" }, { markdown: "p2" }],
    })).toBe("p1\n\np2");
  });

  it("collects markdown from { pages: [{ text }, ...] } shape", () => {
    expect(marker.__test__.collectMarkdown({
      pages: [{ text: "page-a" }, { text: "page-b" }],
    })).toBe("page-a\n\npage-b");
  });

  it("normalizes line items from a marker markdown payload", () => {
    const out = marker.__test__.normalizeFromMarker({ markdown: SAMPLE_MD_TABLE });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[1].partNumber).toBe("BRG-6205");
  });
});

describe("unstructured / endpoint resolution", () => {
  let savedEp;
  beforeEach(() => { savedEp = process.env.UNSTRUCTURED_ENDPOINT; });
  afterEach(() => {
    // Restore exactly: setting `process.env.X = undefined` writes
    // the literal string "undefined", not a delete. Use delete when
    // the original value was unset.
    if (savedEp == null) delete process.env.UNSTRUCTURED_ENDPOINT;
    else process.env.UNSTRUCTURED_ENDPOINT = savedEp;
  });

  it("falls back to the hosted URL when nothing configured", () => {
    delete process.env.UNSTRUCTURED_ENDPOINT;
    expect(unstructured.__test__.endpoint({})).toMatch(/api\.unstructured\.io/);
    expect(unstructured.__test__.isHosted("https://api.unstructured.io/general/v0/general")).toBe(true);
  });

  it("uses the env override when set", () => {
    process.env.UNSTRUCTURED_ENDPOINT = "http://unstructured.local:8000/general/v0/general";
    expect(unstructured.__test__.endpoint({})).toBe("http://unstructured.local:8000/general/v0/general");
    expect(unstructured.__test__.isHosted("http://unstructured.local:8000/general/v0/general")).toBe(false);
  });

  it("settings override beats env override", () => {
    process.env.UNSTRUCTURED_ENDPOINT = "http://from-env";
    expect(unstructured.__test__.endpoint({ docai_unstructured_endpoint: "http://from-settings" }))
      .toBe("http://from-settings");
  });

  it("isConfigured = true on a self-hosted endpoint with no key", () => {
    const saved = process.env.UNSTRUCTURED_API_KEY;
    delete process.env.UNSTRUCTURED_API_KEY;
    try {
      expect(unstructured.isConfigured({ docai_unstructured_endpoint: "http://unstructured.local" })).toBe(true);
    } finally { process.env.UNSTRUCTURED_API_KEY = saved; }
  });

  it("isConfigured = false on the hosted URL without a key", () => {
    const saved = process.env.UNSTRUCTURED_API_KEY;
    delete process.env.UNSTRUCTURED_API_KEY;
    try {
      expect(unstructured.isConfigured({})).toBe(false);
    } finally { process.env.UNSTRUCTURED_API_KEY = saved; }
  });
});

describe("dispatcher / OSS adapters registered", () => {
  it("imports cleanly without throwing", async () => {
    // The dispatcher loads each adapter at module-load time. Make
    // sure the new docling + marker imports don't break the module
    // graph for callers (so-intake, source PO ack, etc.).
    const mod = await import("../api/_lib/docai/index.js");
    expect(typeof mod.dispatchExtract).toBe("function");
  });
});
