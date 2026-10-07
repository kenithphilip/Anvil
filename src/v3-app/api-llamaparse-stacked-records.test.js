// A PO that prints each item as a four-row block, under a four-row header.
//
// Production (one 6-page, 25-item PO that LlamaParse read after Gemini and
// Claude had both failed): the merged table came back as ONE <table> whose
// <thead> held four label rows. The parser read only the first label row, so
// the three lower label rows became "lines", then every item became four
// lines, 103 in all. "Unit Price" on this layout INCLUDES the per-unit GST, so
// the order showed the GST-inclusive total as its taxable value. And the
// adapter returned customer: null, so the SO header had no PO number, no date
// and no buyer.
//
// EVERY VALUE BELOW IS INVENTED. The fixture copies the layout (the label rows,
// which row carries which field, the merged "Maker" and "Delivery" cells, the
// header block repeated per page) and nothing else. The arithmetic is
// consistent by construction: Ex-Price + SGST + CGST = Unit Price, and qty x
// Unit Price = TotAmt.

import { describe, it, expect, vi, afterEach } from "vitest";
import { __test__ } from "../api/_lib/docai/llamaparse.js";
import { readPoHeader } from "../api/_lib/docai/po-header-text.js";
import { conformLines } from "../api/_lib/docai/line-schema.js";
import { detectAnomalies } from "../api/_lib/docai/anomaly.js";

const { normalizeFromHtml, normalizeFromMarkdown, parseHtmlTables, isLabelRow, scoreConfidence, readHeader } = __test__;

const OWN = { einvoice_seller_legal_name: "Fixture Supplier Tools Pvt Ltd", einvoice_seller_gstin: "27AAAAA0000A1Z5" };

// One invented item. Ex-Price is a multiple of 40 so 9% SGST and 9% CGST are
// exact to the paisa.
const item = (n) => {
  const qty = (n % 3) + 1;
  const pre = 1000 + 40 * n;
  const sgst = +(pre * 0.09).toFixed(3);
  const cgst = sgst;
  const unit = +(pre + sgst + cgst).toFixed(4);
  const tot = +(qty * unit).toFixed(3);
  const dd = String((n % 28) + 1).padStart(2, "0");
  return {
    n, qty, pre, sgst, cgst, unit, tot,
    code: "FXI" + String(n).padStart(4, "0"),
    desc: "FIXTURE PART " + n,
    spec: "DRW-" + n + "-A",
    req: String(4400000000 + n),
    // Day-first on the page: 1-28 January 2027.
    delivery: dd + "/01/2027",
    deliveryIso: "2027-01-" + dd,
  };
};
const ITEMS = Array.from({ length: 25 }, (_, i) => item(i + 1));
const fmt = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

const TAXABLE = +ITEMS.reduce((s, it) => s + it.qty * it.pre, 0).toFixed(2);
const GST = +ITEMS.reduce((s, it) => s + it.qty * (it.sgst + it.cgst), 0).toFixed(2);
const GRAND = +ITEMS.reduce((s, it) => s + it.tot, 0).toFixed(2);

const HEAD_ROWS = [
  ["S.No", "Item No", "Qty", "Ex·Price", "Excise Duty", "SGST", "Unit Price", "Maker", "Maker", ""],
  ["", "Description", "U/M", "Tooling Cost", "Ed. Cess", "CGST", "TotAmt", "", "", ""],
  ["", "Specification", "CUR", "P&amp;F", "S·VAT", "IGST", "", "Delivery", "Delivery", ""],
  ["", "Req.No", " ", "Others'", "C·VAT", "UTGST", "Inspection Item", "", "", "Item"],
];
const block = (it) => [
  [String(it.n), it.code, fmt(it.qty, 3), fmt(it.pre, 3), "0.000", fmt(it.sgst, 3), fmt(it.unit, 4), "", "MAKERCO", ""],
  ["", it.desc, "NOS", "0.000", "0.000", fmt(it.cgst, 3), fmt(it.tot, 3), "", "", ""],
  ["", it.spec, "INR", "0.000", "0.000", "0.000", "", "", it.delivery, ""],
  ["", it.req, " ", "0.000", "0.000", "0.000", "N", "", "", ""],
];
const tr = (cells, tag) => "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";

// subHeaderInBody: the emitter puts the three lower label rows in <tbody> as
// ordinary <td> rows, the other shape a parser can see.
const table = (items, { subHeaderInBody = false } = {}) => {
  const head = subHeaderInBody ? [HEAD_ROWS[0]] : HEAD_ROWS;
  const bodyLead = subHeaderInBody ? HEAD_ROWS.slice(1).map((r) => tr(r, "td")).join("") : "";
  return "<table><thead>" + head.map((r) => tr(r, "th")).join("") + "</thead><tbody>"
    + bodyLead + items.flatMap(block).map((r) => tr(r, "td")).join("") + "</tbody></table>";
};

// The header block, as LlamaParse rendered it: the buyer's name as an H1, the
// title, the labels in bold, then the supplier block (US) and our GSTIN.
const headerBlock = () => [
  "# FIXTURE BUYER INDUSTRIES PVT LTD",
  "Plot 7, Example Industrial Estate, Sample City",
  "# PURCHASE ORDER",
  "**OUR REF NO :** PO-FX-0001",
  "**Date :** 01/10/2026",
  "**TO** A. Contact",
  "**VENDOR_CODE. :** ZQ9X",
  "# FIXTURE SUPPLIER TOOLS PVT LTD",
  "**GSTN :** 27AAAAA0000A1Z5",
  "Total Amount : INR " + fmt(GRAND, 2),
].join("\n");

// Pages merged into one table; the header block repeats once per page.
const doc = (opts) => headerBlock() + "\n\n" + table(ITEMS, opts) + "\n\n" + headerBlock() + "\n\n" + headerBlock();

describe("stacked records: 25 items x 4 rows under a 4-row header", () => {
  const r = normalizeFromHtml(doc());

  it("returns exactly 25 lines, one per printed S.No, and no header row as a line", () => {
    expect(r.lines).toHaveLength(25);
    expect(r.lines.map((l) => l.lineNo)).toEqual(ITEMS.map((it) => it.n));
    for (const l of r.lines) {
      for (const label of ["Description", "Specification", "Req.No", "S.No", "Item No"]) {
        expect(l.customerItemCode).not.toBe(label);
        expect(l.description).not.toBe(label);
      }
    }
  });

  it("gives each line the fields its lower rows carry", () => {
    r.lines.forEach((l, i) => {
      const it = ITEMS[i];
      expect(l).toMatchObject({
        customerItemCode: it.code,
        description: it.desc,
        specification: it.spec,
        requisition_no: it.req,
        quantity: it.qty,
        uom: "NOS",
        currency: "INR",
        delivery_date: it.deliveryIso,
        _record_rows: 4,
      });
    });
  });

  it("takes the pre-tax Ex-Price as the rate, keeps the per-unit taxes, and records why", () => {
    r.lines.forEach((l, i) => {
      const it = ITEMS[i];
      expect(l.unitPrice).toBe(it.pre);
      expect(l.sgst_amount).toBe(it.sgst);
      expect(l.cgst_amount).toBe(it.cgst);
      expect(l.line_total).toBeCloseTo(it.tot, 2);
      expect(l._rate_basis).toMatchObject({
        basis: "pre_tax", unit_includes: "tax", pre_tax_price: it.pre, unit_price_printed: it.unit, total_check: "gross",
      });
    });
  });

  it("adds back to the printed total once tax is added back", () => {
    const taxable = r.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const tax = r.lines.reduce((s, l) => s + l.quantity * (l.sgst_amount + l.cgst_amount), 0);
    expect(+taxable.toFixed(2)).toBe(TAXABLE);
    expect(+tax.toFixed(2)).toBe(GST);
    expect(+(taxable + tax).toFixed(2)).toBe(GRAND);
  });

  it("reports the merged rows in table_diag.continuation, and the record depth", () => {
    expect(r.diag).toMatchObject({
      tables: 1, matched: 1, misaligned: 0, max_line_no: 25, continuation: 75,
      record_rows: 4, rows_considered: 25, rows_rejected: 0, rate_pre_tax: 25,
    });
    expect(r.diag.rate_unproven).toBeUndefined();
    expect(r.diag.total_mismatch).toBeUndefined();
  });

  it("reads the same when the lower label rows arrive as <tbody> rows", () => {
    const b = normalizeFromHtml(doc({ subHeaderInBody: true }));
    expect(b.lines).toHaveLength(25);
    expect(b.lines.map((l) => [l.customerItemCode, l.description, l.requisition_no, l.unitPrice]))
      .toEqual(r.lines.map((l) => [l.customerItemCode, l.description, l.requisition_no, l.unitPrice]));
    expect(b.diag.continuation).toBe(75);
  });

  it("crosses the schema boundary with no undeclared field", () => {
    const { diag } = conformLines({ lines: r.lines });
    expect(diag.unknown).toEqual([]);
  });

  it("scores a complete read above the fallback threshold", () => {
    // The buyer's item code is the line's identity on this layout; there is no
    // part column of ours.
    expect(scoreConfidence(r.lines)).toBeGreaterThanOrEqual(0.85);
  });

  it("raises no anomaly on the folded-free, proven line set", () => {
    const { normalized } = conformLines({ classification: "po", lines: r.lines, stated_line_count: 25 });
    const out = detectAnomalies(normalized, { kind: "po", bodyText: "PURCHASE ORDER\nTotal Amount : INR " + fmt(GRAND, 2) });
    expect(out.anomalies.filter((a) => a.severity !== "info")).toEqual([]);
  });
});

describe("the rate is switched only when the figures prove it", () => {
  const one = (cells) => "<table><thead>" + HEAD_ROWS.map((h) => tr(h, "th")).join("")
    + "</thead><tbody>" + cells.map((c) => tr(c, "td")).join("") + "</tbody></table>";

  it("keeps the printed unit price, keeps the taxes off the line, and says so, when unit != pre-tax + taxes", () => {
    const it = ITEMS[0];
    const rows = block(it);
    rows[0][6] = fmt(it.unit + 50, 4);              // a unit price the taxes do not explain
    const r = normalizeFromHtml(one(rows));
    const [l] = r.lines;
    expect(l.unitPrice).toBe(+(it.unit + 50).toFixed(4));
    expect(l.sgst_amount).toBeUndefined();
    expect(l._rate_basis).toMatchObject({ basis: "unproven", pre_tax_price: it.pre, taxes_printed: { sgst_amount: it.sgst } });
    expect(r.diag.rate_unproven).toBe(1);
    const a = detectAnomalies({ lines: r.lines }, { kind: "po" });
    expect(a.anomalies.find((x) => x.code === "rate_basis_unproven")).toMatchObject({ severity: "warn", line_index: 0 });
  });

  it("flags a printed line total that is neither the gross nor the taxable value", () => {
    const it = ITEMS[1];
    const rows = block(it);
    rows[1][6] = fmt(it.tot + 1000, 3);
    const r = normalizeFromHtml(one(rows));
    expect(r.lines[0].unitPrice).toBe(it.pre);
    expect(r.lines[0]._rate_basis.total_check).toBe("mismatch");
    expect(r.diag.total_mismatch).toBe(1);
    const a = detectAnomalies({ lines: r.lines }, { kind: "po" });
    expect(a.anomalies.find((x) => x.code === "line_total_inconsistent")).toMatchObject({ severity: "warn", line_index: 0 });
  });

  it("accepts a printed total that is the taxable value, and does not call it the gross", () => {
    const it = ITEMS[2];
    const rows = block(it);
    rows[1][6] = fmt(it.qty * it.pre, 3);
    const [l] = normalizeFromHtml(one(rows)).lines;
    expect(l.unitPrice).toBe(it.pre);
    expect(l._rate_basis.total_check).toBe("pre_tax");
    expect(l.line_total).toBeNull();
    expect(l._rate_basis.total_printed).toBe(it.qty * it.pre);
  });
});

describe("one-row headers are unchanged", () => {
  // The production one-row layout (see api-llamaparse-html-tables.test.js),
  // pinned field by field: the record path must not touch it.
  const TH = ["Line", "Item Number", "Service Parent Name", "Item Description", "Item Specification",
    "Need By Date", "Start Date", "End Date", "Quantity", "UOM", "Unit Price", "Other Charges", "Taxes", "Line Total"];
  const cells = (n) => [String(n), `AC${100000 + n}XX01`, "-", `ACME STD SHANK PN-${n}-90-2`, "-",
    "3/31/2026", "-", "-", "1.00", "each", "1,000.80", "0.00", "180.14", "1,180.94"];
  const html = "<table><thead>" + TH.map((h) => `<th>${h}</th>`).join("") + "</thead><tbody>"
    + [1, 2, 3].map((n) => tr(cells(n), "td")).join("") + "</tbody></table>";

  it("produces exactly the lines it did before", () => {
    const r = normalizeFromHtml(html);
    expect(r.lines).toEqual([1, 2, 3].map((n) => ({
      _source: "table_columns", lineNo: n, partNumber: null, customerItemCode: `AC${100000 + n}XX01`,
      description: `ACME STD SHANK PN-${n}-90-2`, specification: null, quantity: 1, unitPrice: 1000.8,
      uom: "each", hsn: null, tax_amount: 180.14, line_total: 1180.94,
    })));
    expect(r.diag).toEqual({ tables: 1, matched: 1, continuation: 0, skipped: 0, misaligned: 0,
      rows_considered: 3, rows_rejected: 0, max_line_no: 3 });
  });

  it("keeps the pipe-table path as it was", () => {
    const md = "| Part No | Qty | Unit Price |\n|---|---|---|\n| PN-1 | 2 | 10 |";
    expect(normalizeFromMarkdown(md).lines).toEqual([{ partNumber: "PN-1", description: null, quantity: 2, unitPrice: 10, hsn: null }]);
  });
});

describe("isLabelRow", () => {
  it("recognises the lower label rows and refuses data rows", () => {
    expect(isLabelRow(HEAD_ROWS[1])).toBe(true);
    expect(isLabelRow(HEAD_ROWS[3])).toBe(true);
    expect(isLabelRow(block(ITEMS[0])[1])).toBe(false);
    expect(isLabelRow(["", "BEARING HOUSING", "NOS", "", ""])).toBe(false);
  });

  it("parses the 4-row thead as four rows", () => {
    expect(parseHtmlTables(table(ITEMS.slice(0, 1)))[0].slice(0, 4).map((r) => r[1]))
      .toEqual(["Item No", "Description", "Specification", "Req.No"]);
  });
});

describe("PO header from the markdown", () => {
  it("reads PO number, date, vendor code, currency, buyer and printed total", () => {
    const h = readHeader(doc(), OWN);
    expect(h.customer).toMatchObject({
      name: "FIXTURE BUYER INDUSTRIES PVT LTD",
      po_number: "PO-FX-0001",
      po_date: "2026-10-01",
      vendor_code: "ZQ9X",
      currency: "INR",
      _name_source: "letterhead",
      _source: "header_text",
    });
    expect(h.totals).toEqual({ grand_total: GRAND });
  });

  it("never takes our own company or our GSTIN as the buyer", () => {
    const h = readHeader(doc(), OWN);
    expect(h.customer.name).not.toMatch(/SUPPLIER/);
    expect(h.customer.gstin).toBeUndefined();
  });

  it("does not take the supplier block as the buyer even when our identity is not configured", () => {
    const md = ["# PURCHASE ORDER", "**PO No :** 7700123", "**TO**", "# FIXTURE SUPPLIER TOOLS PVT LTD", "**GSTN :** 27AAAAA0000A1Z5"].join("\n");
    const h = readPoHeader(md);
    expect(h.customer.name).toBeUndefined();
    expect(h.customer.gstin).toBeUndefined();
    expect(h.customer.po_number).toBe("7700123");
  });

  it("skips a letterhead that is our own name", () => {
    const md = ["# Fixture Supplier Tools Private Limited", "# FIXTURE BUYER INDUSTRIES", "# PURCHASE ORDER", "PO No: 55"].join("\n");
    expect(readPoHeader(md, { ownNames: ["Fixture Supplier Tools Pvt. Ltd."] }).customer.name).toBe("FIXTURE BUYER INDUSTRIES");
  });

  it("prefers a labelled Bill To block, and takes a GSTIN only from it, never ours", () => {
    const md = [
      "# FIXTURE GROUP HOLDINGS", "# PURCHASE ORDER", "P.O. No. 4500001234", "PO Date: 15-07-2026",
      "**Bill To:**", "Fixture Buyer Plant 2 Pvt Ltd", "Sector 9, Sample Town", "GSTIN: 29AABCF1234K1Z9",
      "**Vendor:** Fixture Supplier Tools Pvt Ltd", "GSTIN: 27AAAAA0000A1Z5",
    ].join("\n");
    const h = readPoHeader(md, { ownNames: ["Fixture Supplier Tools"], ownGstins: ["27AAAAA0000A1Z5"] });
    expect(h.customer).toMatchObject({
      name: "Fixture Buyer Plant 2 Pvt Ltd", gstin: "29AABCF1234K1Z9", po_number: "4500001234",
      po_date: "2026-07-15", _name_source: "buyer_block",
    });
    expect(h.customer.bill_to_address).toMatch(/Sector 9/);
  });

  it("never takes our GSTIN, even when it is printed inside the buyer block", () => {
    const md = [
      "# PURCHASE ORDER", "PO No: 7700456",
      "**Bill To:**", "Fixture Buyer Plant 3 Pvt Ltd", "Sector 4, Sample Town", "GSTIN: 27AAAAA0000A1Z5",
    ].join("\n");
    const h = readPoHeader(md, { ownGstins: ["27AAAAA0000A1Z5"] });
    expect(h.customer.name).toBe("Fixture Buyer Plant 3 Pvt Ltd");
    expect(h.customer.gstin).toBeUndefined();
  });

  it("reads nothing as a PO number from prose, and nothing from a delivery date", () => {
    const md = ["# FIXTURE BUYER", "Please quote the Order No. on all invoices.", "Delivery Date: 03/03/2027"].join("\n");
    const h = readPoHeader(md);
    expect(h.customer.po_number).toBeUndefined();
    expect(h.customer.po_date).toBeUndefined();
  });

  it("returns customer null when the markdown has no header at all", () => {
    expect(readPoHeader(table(ITEMS.slice(0, 2))).customer).toBeNull();
  });
});

// The adapter end to end, with the LlamaCloud SDK stubbed: the header and the
// stacked lines must both reach normalized, which is what the dispatcher, the
// fold and the intake read.
describe("extract(): the header and the stacked lines reach normalized", () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock("@llamaindex/llama-cloud"); delete process.env.LLAMAPARSE_API_KEY; });

  it("returns 25 lines, the PO header, the printed total and the conservation counts", async () => {
    process.env.LLAMAPARSE_API_KEY = "llx-test";
    vi.doMock("@llamaindex/llama-cloud", () => ({
      default: class { constructor() { this.parsing = { parse: async () => ({ markdown_full: doc(), job: { id: "job-fx" } }) }; } },
      toFile: async (b, n, o) => ({ name: n, type: o?.type, bytes: b }),
    }));
    const { extract } = await import("../api/_lib/docai/llamaparse.js");
    const out = await extract({ bytes: Buffer.from("%PDF-1.4"), filename: "po.pdf", mime: "application/pdf", settings: OWN });
    expect(out.ok).toBe(true);
    expect(out.normalized.lines).toHaveLength(25);
    expect(out.normalized.customer).toMatchObject({
      name: "FIXTURE BUYER INDUSTRIES PVT LTD", po_number: "PO-FX-0001", po_date: "2026-10-01", vendor_code: "ZQ9X",
    });
    expect(out.normalized.totals).toEqual({ grand_total: GRAND });
    expect(out.normalized.stated_line_count).toBe(25);
    expect(out.normalized.parse_conservation).toMatchObject({
      rows_considered: 25, rows_rejected: 0, lines_emitted: 25, max_line_no: 25, record_rows: 4, continuation_rows: 75,
    });
    expect(out.raw.table_diag.continuation).toBe(75);
    expect(out.raw.header_fields).toEqual(expect.arrayContaining(["po_number", "po_date", "vendor_code", "name", "grand_total"]));
    expect(out.confidences.overall).toBeGreaterThanOrEqual(0.85);
  });
});
