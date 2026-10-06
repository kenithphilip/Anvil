// The quote correction field map. The interesting tests here are not the
// getters — they are the three that check the map against reality:
//
//   - every extractKey survives into the STORED extract, which is not the same
//     object as the tool schema (this is the one that matters most);
//   - every extractKey is a real property of QUOTE_TOOL's schema, so renaming
//     a schema field breaks the build instead of silently writing corrections
//     to a path that no longer exists;
//   - every column is a real quote_lines / quotes column selected by the route
//     that feeds the tab, so a column rename is caught the same way.
//
// Both read the source files as text rather than importing them: claude.js
// pulls in the provider SDK and orders/quotes.js pulls in the request stack,
// neither of which belongs in a unit test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  QUOTE_LINE_FIELDS, lineFieldFor, lineFieldPath, coerceCorrection,
} from "./quote-field-paths";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// The QUOTE_TOOL block, from `const QUOTE_TOOL` to the line-items schema end.
const quoteToolSource = (() => {
  const src = read("src/api/_lib/docai/claude.js");
  const start = src.indexOf("const QUOTE_TOOL");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n};", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
})();

// The `...(isQuote ? { ... } : {})` spread in claude.js's normalizer — the
// shape a quote extraction is actually STORED in.
const storedQuoteRootKeys = (() => {
  const src = read("src/api/_lib/docai/claude.js");
  const start = src.indexOf("...(isQuote ? {");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("} : {}),", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end).match(/^\s{8}([a-z_]+):/gm)?.map((m) => m.trim().replace(":", "")) || [];
})();

describe("the map is grounded in what is actually STORED", () => {
  // The tool schema and the stored extract are NOT the same object, and
  // assuming they are is a bug this repo has already shipped once: the quote
  // scoring profile read `customer_name` — a real QUOTE_TOOL property — but
  // the normalizer consumes it and re-emits `customer: { name }`, so the
  // profile's customer check silently never fired on any quote golden.
  it("the normalizer keeps lines under `lines`, which every path assumes", () => {
    // toQuoteLineRow maps normalized.lines 1:1, so `lines[N]` is the address.
    expect(read("src/api/_lib/docai/claude.js")).toMatch(/normalized: \{[\s\S]{0,400}\blines,/);
  });

  it("offers no field the normalizer strips on its way to storage", () => {
    // customer_name is the known casualty; assert the line map contains no
    // key that only exists on the tool schema side.
    expect(QUOTE_LINE_FIELDS.map((f) => f.extractKey)).not.toContain("customer_name");
    expect(storedQuoteRootKeys).not.toContain("customer_name");
  });
});

describe("the map is grounded in the extractor's schema", () => {
  it("every line extractKey is a property of QUOTE_TOOL", () => {
    for (const f of QUOTE_LINE_FIELDS) {
      expect(
        new RegExp("\\b" + f.extractKey + ": \\{").test(quoteToolSource),
        `QUOTE_TOOL has no line property "${f.extractKey}" (mapped from column "${f.column}")`,
      ).toBe(true);
    }
  });

  it("does not offer a field the extractor never emits", () => {
    // discount_pct is computed by quote-ingest from list and net; it exists as
    // a column and is rendered, but correcting it would write a leaf the
    // extract does not contain — and harvest-corrected's pathExists stops one
    // segment short, so it would be materialised as a phantom field rather
    // than skipped.
    expect(lineFieldFor("discount_pct")).toBeNull();
    expect(quoteToolSource).not.toMatch(/\bdiscount_pct: \{/);
  });

  it("does not offer the summed GST column", () => {
    // Rendered as one column, stored as three fields — a correction there
    // cannot be attributed, so the cell stays read-only.
    expect(lineFieldFor("cgst_pct")).toBeNull();
    expect(lineFieldFor("igst_pct")).toBeNull();
  });
});

describe("the map is grounded in the route's column list", () => {
  const routeSource = read("src/api/orders/quotes.js");
  // The quote_lines select in the detail branch.
  const lineSelect = (() => {
    const m = /\.select\("line_index, ([^"]+)"\)/.exec(routeSource);
    expect(m, "quote_lines select not found in orders/quotes.js").toBeTruthy();
    return ("line_index, " + (m as RegExpExecArray)[1]).split(",").map((s) => s.trim());
  })();

  it("every correctable line column is selected by the route", () => {
    for (const f of QUOTE_LINE_FIELDS) {
      expect(lineSelect, `column "${f.column}" is not selected by orders/quotes.js`).toContain(f.column);
    }
  });

  it("the route still returns line_index — the whole map depends on it", () => {
    expect(lineSelect).toContain("line_index");
  });

  it("the route exposes an extraction_run_id for the tab to correct against", () => {
    expect(routeSource).toMatch(/extraction_run_id: extractionRunId/);
  });
});

describe("lineFieldPath", () => {
  it("builds the extract path, not the column path", () => {
    expect(lineFieldPath("discounted_unit_price", 3)).toBe("lines[3].unitPrice");
    expect(lineFieldPath("qty", 0)).toBe("lines[0].quantity");
    expect(lineFieldPath("hsn_sac", 11)).toBe("lines[11].hsn");
    expect(lineFieldPath("listed_unit_price", 2)).toBe("lines[2].listUnitPrice");
  });

  it("uses line_index, never the render position", () => {
    // The ingest drops hollow lines AFTER stamping line_index, so index 7 can
    // be the 3rd rendered row. The path must follow the extract, not the table.
    expect(lineFieldPath("qty", 7)).toBe("lines[7].quantity");
  });

  it("refuses a row with no line_index rather than guessing", () => {
    expect(lineFieldPath("qty", null)).toBeNull();
    expect(lineFieldPath("qty", undefined)).toBeNull();
    expect(lineFieldPath("qty", -1)).toBeNull();
    expect(lineFieldPath("qty", 1.5)).toBeNull();
  });

  it("refuses a column that is not correctable", () => {
    expect(lineFieldPath("discount_pct", 0)).toBeNull();
    expect(lineFieldPath("nonsense", 0)).toBeNull();
  });
});

describe("coerceCorrection", () => {
  it("types a number field as a number", () => {
    expect(coerceCorrection("1250", "number")).toEqual({ ok: true, value: 1250 });
    expect(coerceCorrection(" 1250.50 ", "number")).toEqual({ ok: true, value: 1250.5 });
  });

  it("accepts the thousands separators the document prints", () => {
    expect(coerceCorrection("1,25,000", "number")).toEqual({ ok: true, value: 125000 });
  });

  it("refuses a number that will not parse rather than writing NaN", () => {
    const r = coerceCorrection("about 900", "number");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/number/i);
  });

  it("treats an emptied field as a real correction to null", () => {
    // The extractor inventing a value that is not on the page is a defect,
    // and clearing the cell is how the operator records it.
    expect(coerceCorrection("", "number")).toEqual({ ok: true, value: null });
    expect(coerceCorrection("   ", "text")).toEqual({ ok: true, value: null });
  });

  it("trims a text field", () => {
    expect(coerceCorrection("  BRG-6204 ", "text")).toEqual({ ok: true, value: "BRG-6204" });
  });
});
