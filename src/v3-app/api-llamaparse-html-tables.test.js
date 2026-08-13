// LlamaParse agentic-tier output is HTML tables, not pipe tables.
//
// A real 13-page PO came back as 51,613 characters of markdown containing the
// COMPLETE line-item table as <table> markup — every row present, correct
// column headers — and parseMarkdownTable found zero pipe rows in it. The
// adapter reported "no parsable line-item table" on a document it had parsed
// perfectly, and had been doing so for weeks.
//
// Nothing in Anvil changed: the adapter sends version "latest", so LlamaParse
// changed its output format underneath us. These tests pin both shapes.
//
// FIXTURES ARE SYNTHETIC. The real rows carry buyer/seller identity and part
// codes that api-docai-prompt-tenant-neutrality.test.js forbids appearing in
// this repo.

import { describe, it, expect, afterEach } from "vitest";
import { __test__ } from "../api/_lib/docai/llamaparse.js";

const { normalizeFromMarkdown, normalizeFromHtml, parseHtmlTables } = __test__;

// The exact column set observed in production.
const TH = ["Line", "Item Number", "Service Parent Name", "Item Description", "Item Specification",
  "Need By Date", "Start Date", "End Date", "Quantity", "UOM", "Unit Price", "Other Charges", "Taxes", "Line Total"];

const row = (n) => {
  const qty = 1, price = 1000 + n * 7.5, tax = +(price * 0.18).toFixed(2);
  return { cells: [n, `AC${100000 + n}XX01`, "-", `ACME STD SHANK PN-${n}-90-2`, "-",
    "3/31/2026", "-", "-", qty.toFixed(2), "each", price.toFixed(2), "0.00",
    tax.toFixed(2), (qty * price + tax).toFixed(2)], total: qty * price + tax };
};

// Header cells bare inside <thead>, data rows wrapped in <tr> — the shape
// production actually emits.
const makeDoc = (pages, perPage, { headerInTr = false, tail = true } = {}) => {
  const head = headerInTr
    ? "<thead><tr>" + TH.map((h) => `<th>${h}</th>`).join("") + "</tr></thead>"
    : "<thead>" + TH.map((h) => `<th>${h}</th>`).join("") + "</thead>";
  let n = 0, grand = 0, tables = [];
  for (let p = 0; p < pages; p++) {
    let body = "";
    for (let i = 0; i < perPage; i++) {
      n++; const r = row(n); grand += r.total;
      body += "<tr>" + r.cells.map((c) => `<td>${c}</td>`).join("") + "</tr>";
    }
    tables.push(`<table>${head}<tbody>${body}</tbody></table>`);
  }
  const doc = "# ACME LTD\n**PO Number**: 123\n## Line Details\n" + tables.join("\n\nPage\n\n")
    + (tail ? `<table><thead><th>Tax</th><th>Rate</th><th>Amount</th></thead><tbody><tr><td>CGST</td><td>9</td><td>1</td></tr></tbody></table>` : "");
  return { doc, count: n, grand: +grand.toFixed(2) };
};

describe("parseHtmlTables", () => {
  it("recovers a header that sits outside <tr> (the production shape)", () => {
    const { doc } = makeDoc(1, 2);
    const t = parseHtmlTables(doc)[0];
    expect(t[0]).toEqual(TH);
    expect(t.length).toBe(3);           // header + 2 data rows
  });

  it("also handles a header wrapped in <tr>, without duplicating it", () => {
    const { doc } = makeDoc(1, 2, { headerInTr: true });
    const t = parseHtmlTables(doc)[0];
    expect(t[0]).toEqual(TH);
    expect(t.filter((r) => r[0] === "Line")).toHaveLength(1);
  });

  it("chunks the <td> stream by header width when there is no <tr> at all", () => {
    const html = "<table><thead><th>Item Number</th><th>Description</th><th>Quantity</th><th>Unit Price</th></thead>"
      + "<td>A1</td><td>WIDGET</td><td>2</td><td>10</td><td>A2</td><td>GEAR</td><td>3</td><td>20</td></table>";
    const t = parseHtmlTables(html)[0];
    expect(t).toHaveLength(3);
    expect(t[2]).toEqual(["A2", "GEAR", "3", "20"]);
  });
});

describe("normalizeFromHtml", () => {
  it("recovers every line across pages and skips the tax-summary table", () => {
    const { doc, count } = makeDoc(6, 9);
    const r = normalizeFromHtml(doc);
    expect(r.lines).toHaveLength(count);
    expect(r.diag.matched).toBe(6);
    expect(r.diag.skipped).toBe(1);      // the trailing tax table
    expect(r.lines.some((l) => /CGST/i.test(l.description || ""))).toBe(false);
  });

  it("does not leak the repeated header rows in as line items", () => {
    const { doc } = makeDoc(3, 5);
    const r = normalizeFromHtml(doc);
    expect(r.lines.some((l) => l.customerItemCode === "Item Number")).toBe(false);
  });

  it("maps Item Description, NOT Service Parent Name", () => {
    // /desc|name/ matches "Service Parent Name" (index 2, always "-") before
    // "Item Description" (index 3). Preference order is load-bearing.
    const { doc } = makeDoc(1, 1);
    const l = normalizeFromHtml(doc).lines[0];
    expect(l.description).toMatch(/STD SHANK/);
    expect(l.description).not.toBe("-");
  });

  it('nulls "-" cells rather than carrying them into matching', () => {
    const l = normalizeFromHtml(makeDoc(1, 1).doc).lines[0];
    expect(l.specification).toBeNull();
    expect(l.partNumber).toBeNull();     // this layout has no part column
    expect(l.customerItemCode).toBe("AC100001XX01");
  });

  it("captures the money columns, making completeness exact", () => {
    const { doc, count, grand } = makeDoc(4, 8);
    const r = normalizeFromHtml(doc);
    expect(r.lines).toHaveLength(count);
    const sum = +r.lines.reduce((a, l) => a + (l.line_total || 0), 0).toFixed(2);
    expect(sum).toBeCloseTo(grand, 2);
    expect(r.lines[0].tax_amount).toBeGreaterThan(0);
  });

  it("returns no lines when there is no line-item table", () => {
    const html = "<table><thead><th>Vendor</th><th>Address</th></thead><tbody><tr><td>ACME</td><td>Pune</td></tr></tbody></table>";
    expect(normalizeFromHtml(html).lines).toHaveLength(0);
  });
});

describe("normalizeFromMarkdown falls through to HTML", () => {
  it("parses an HTML-table document that has zero pipe rows", () => {
    const { doc, count } = makeDoc(3, 7);
    expect(doc.match(/^\s*\|/gm)).toBeNull();          // matches production: 0 pipe rows
    expect(normalizeFromMarkdown(doc).lines).toHaveLength(count);
  });

  it("still prefers pipe tables when present (no regression)", () => {
    const md = "| Part No | Qty | Unit Price |\n|---|---|---|\n| PN-1 | 2 | 10 |\n| PN-2 | 3 | 20 |";
    const r = normalizeFromMarkdown(md);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].partNumber).toBe("PN-1");
  });

  it("reports diagnostics when neither shape yields lines", () => {
    const r = normalizeFromMarkdown("just prose, no tables at all, nothing to parse here");
    expect(r.lines).toHaveLength(0);
    expect(r.diag).toBeTruthy();
  });
});

describe("version pinning is tier-aware", () => {
  // A version string belongs to exactly one tier; pairing an agentic version
  // with cost_effective is a validation error. LLAMAPARSE_TIER is
  // env-overridable, so a single global pin would break the moment anyone
  // changed tier. Values are the v2 API reference's current `latest` per tier.
  const orig = process.env.LLAMAPARSE_TIER;
  const origV = process.env.LLAMAPARSE_VERSION;
  afterEach(() => {
    if (orig === undefined) delete process.env.LLAMAPARSE_TIER; else process.env.LLAMAPARSE_TIER = orig;
    if (origV === undefined) delete process.env.LLAMAPARSE_VERSION; else process.env.LLAMAPARSE_VERSION = origV;
  });

  it.each([
    ["fast", "2026-06-15"],
    ["cost_effective", "2026-06-26"],
    ["agentic", "2026-07-15"],
    ["agentic_plus", "2026-07-08"],
  ])("%s pins to %s", (t, v) => {
    process.env.LLAMAPARSE_TIER = t;
    delete process.env.LLAMAPARSE_VERSION;
    expect(__test__.parseVersion()).toBe(v);
  });

  it("defaults to the agentic pin, matching the default tier", () => {
    delete process.env.LLAMAPARSE_TIER;
    delete process.env.LLAMAPARSE_VERSION;
    expect(__test__.tier()).toBe("agentic");
    expect(__test__.parseVersion()).toBe("2026-07-15");
  });

  it("falls back to latest on an unknown tier rather than sending another tier's version", () => {
    process.env.LLAMAPARSE_TIER = "not_a_tier";
    delete process.env.LLAMAPARSE_VERSION;
    expect(__test__.parseVersion()).toBe("latest");
  });

  it("LLAMAPARSE_VERSION still overrides, so a pin can be abandoned fast", () => {
    process.env.LLAMAPARSE_TIER = "agentic";
    process.env.LLAMAPARSE_VERSION = "latest";
    expect(__test__.parseVersion()).toBe("latest");
  });
});

// ── the shape the real document actually has ───────────────────────────────
//
// Everything above was written against fixtures I INVENTED, and they all passed
// while the parser returned 1 garbage row out of 18 on the real thing. These
// fixtures are traced from the stored raw_extract instead (identity replaced,
// structure preserved), because the structure is where the bugs were:
//
//   page 1     <thead> opens with <th colspan="14">Line Details</th> ABOVE the
//              real 14-cell label row
//   pages 2-13 no column labels at all — the only <th> is a colspan="16" page
//              banner, and every data row is 16 cells: blank + 14 + blank
const REAL_TH = ["Line", "Item Number", "Service Parent Name", "Item Description", "Item Specification",
  "Need By Date", "Start Date", "End Date", "Quantity", "UOM", "Unit Price", "Other Charges", "Taxes", "Line Total"];

const realCells = (n) => [String(n), `AC${100000 + n}XX01`, "-", `ACME STD<br/>SHANK PN-${n}-90-2`, "-",
  "3/31/2026", "-", "-", "1.00", "each", "1,000.80", "0.00", "180.14", "1,180.94"];

const realPage1 = (n = 6) => `<table>
  <thead>
    <tr><th colspan="14">Line Details</th></tr>
    <tr>${REAL_TH.map((h) => `<th>${h}</th>`).join("")}</tr>
  </thead>
  <tbody>${Array.from({ length: n }, (_, i) => `<tr>${realCells(i + 1).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
</table>`;

// Banner is a single spanning cell containing multi-line prose — it collapses to
// ONE cell however many columns it claims to span.
const realPageN = (start, n = 3) => `<table>
  <thead><tr><th colspan="16">ACME LTD
PURCHASE ORDER / CONTRACT / SCHEDULING AGREEMENT
<sub>Some Plant Address</sub>
GST - 00XXXXX0000X0XX</th></tr></thead>
  <tbody>
    <tr><td colspan="16"></td></tr>
    ${Array.from({ length: n }, (_, i) => `<tr><td></td>${realCells(start + i).map((c) => `<td>${c}</td>`).join("")}<td></td></tr>`).join("")}
  </tbody>
</table>`;

const realDoc = (pages = 5) => realPage1() + "\n\n"
  + Array.from({ length: pages - 1 }, (_, i) => realPageN(7 + i * 3)).join("\n\n");

describe("the real document shape", () => {
  it("recovers every line across the banner-only continuation pages", () => {
    const r = normalizeFromHtml(realDoc(5));
    expect(r.lines).toHaveLength(6 + 4 * 3);
    expect(r.diag.matched).toBe(1);          // only page 1 carries labels
    expect(r.diag.continuation).toBe(4);
    expect(r.diag.misaligned).toBe(0);
  });

  it("does not shift columns when a colspan banner sits above the header", () => {
    // The regression: the banner made row 0 mismatch, a 15-wide synthetic
    // header was prepended, and every column read one to the left — producing
    // customerItemCode "Service Parent Name" and quantity 0 for a real row.
    const l = normalizeFromHtml(realDoc(2)).lines[0];
    expect(l.customerItemCode).toBe("AC100001XX01");
    expect(l.description).toBe("ACME STD SHANK PN-1-90-2");
    expect(l.quantity).toBe(1);
    expect(l.unitPrice).toBeCloseTo(1000.8, 2);
    expect(l.line_total).toBeCloseTo(1180.94, 2);
  });

  it("never emits a header label as a data value", () => {
    for (const l of normalizeFromHtml(realDoc(5)).lines) {
      for (const h of REAL_TH) {
        expect(l.customerItemCode).not.toBe(h);
        expect(l.description).not.toBe(h);
      }
    }
  });

  it("strips the spacer cells rather than dropping the 16-wide rows", () => {
    const r = normalizeFromHtml(realPage1(1) + "\n\n" + realPageN(2, 3));
    expect(r.lines).toHaveLength(4);
    expect(r.lines[3].customerItemCode).toBe("AC100004XX01");
  });

  it("still skips a tax summary that follows the line table", () => {
    const tax = `<table><thead><tr><th>Tax</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody><tr><td>CGST</td><td>9</td><td>82,136.77</td></tr></tbody></table>`;
    const r = normalizeFromHtml(realDoc(3) + "\n\n" + tax);
    expect(r.lines).toHaveLength(6 + 2 * 3);
    expect(r.lines.some((l) => /CGST/i.test(l.description || ""))).toBe(false);
  });
});

describe("pickHeaderRow", () => {
  it("skips a single-cell banner and takes the label row below it", () => {
    const rows = [["Line Details"], REAL_TH, realCells(1)];
    expect(__test__.pickHeaderRow(rows)).toBe(1);
  });

  it("returns -1 when a table has no label row, so it can be treated as a continuation", () => {
    expect(__test__.pickHeaderRow([["ACME LTD PURCHASE ORDER"], realCells(1)])).toBe(-1);
  });

  it("rejects a banner even when its prose scores hits", () => {
    // "PURCHASE ORDER ... TOTAL AMOUNT" trips several HEADER_HINTS, but one
    // spanning cell is still one cell.
    expect(__test__.pickHeaderRow([["PURCHASE ORDER — TOTAL AMOUNT, QUANTITY AND ITEM DESCRIPTION"]])).toBe(-1);
  });
});

describe("alignRow", () => {
  it("trims a symmetric spacer pair", () => {
    expect(__test__.alignRow(["", "a", "b", ""], 2)).toEqual(["a", "b"]);
  });

  it("trims a leading-only spacer", () => {
    expect(__test__.alignRow(["", "a", "b"], 2)).toEqual(["a", "b"]);
  });

  it("refuses to trim a non-empty cell, because that silently drops data", () => {
    expect(__test__.alignRow(["x", "a", "b"], 2)).toBeNull();
  });

  it("returns null rather than inventing cells for a too-narrow row", () => {
    expect(__test__.alignRow(["a"], 2)).toBeNull();
  });

  it("passes an exact-width row straight through", () => {
    expect(__test__.alignRow(["a", "b"], 2)).toEqual(["a", "b"]);
  });
});
