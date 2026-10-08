// The same stacked PO, in the OTHER form LlamaParse emits for it.
//
// #563 read a PO whose four-row item blocks sit under a four-row <thead>. A
// production re-run of the same document came back with ONE header row whose
// cells stack the four labels, separated by an ESCAPED line break:
//
//   <th>Item No&#x3C;br/>Description&#x3C;br/>Specification&#x3C;br/>Req.No</th>
//
// and two labels glued with no separator ("TotAmtInspection Item"). The parser
// saw a one-row header, so the item code, description, specification and
// requisition number all mapped to one column, the UOM read the quantity
// ("1.000"), the tax-inclusive Unit Price became the rate, and the fold glued
// every item's four rows into one description.
//
// EVERY VALUE BELOW IS INVENTED. The header and the cell positions copy the
// production form exactly (including the garbled "DeliveryInspection Item"
// column and the delivery date in the first row of the last column). The
// arithmetic is consistent: Ex-Price + SGST + CGST = Unit Price, and
// TotAmt = qty x Unit Price.

import { describe, it, expect } from "vitest";
import { __test__ } from "../api/_lib/docai/llamaparse.js";
import { foldContinuationRows } from "../api/_lib/docai/continuation-rows.js";
import { conformLines } from "../api/_lib/docai/line-schema.js";
import { detectAnomalies } from "../api/_lib/docai/anomaly.js";

const { normalizeFromHtml, normalizeFromMarkdown, unglue } = __test__;

const item = (n) => {
  const qty = (n % 4) + 1;
  const pre = 2000 + 40 * n;                 // a multiple of 40: 9% is exact to the paisa
  const sgst = +(pre * 0.09).toFixed(3);
  const cgst = sgst;
  const unit = +(pre + sgst + cgst).toFixed(4);
  const tot = +(qty * unit).toFixed(3);
  const dd = String((n % 28) + 1).padStart(2, "0");
  return {
    n, qty, pre, sgst, cgst, unit, tot,
    code: "QZX" + String(n).padStart(5, "0"),
    // One description carries an encoded "&", as LlamaParse writes it.
    desc: n === 3 ? "NUT &#x26; BOLT SET" : "SAMPLE COMPONENT " + n,
    descText: n === 3 ? "NUT & BOLT SET" : "SAMPLE COMPONENT " + n,
    spec: "9-SP" + String(1000 + n) + "-1",
    req: String(5500000000 + n),
    delivery: dd + "/02/2027",
    deliveryIso: "2027-02-" + dd,
  };
};
const ITEMS = Array.from({ length: 25 }, (_, i) => item(i + 1));
const fmt = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const TAXABLE = +ITEMS.reduce((s, it) => s + it.qty * it.pre, 0).toFixed(2);
const GST = +ITEMS.reduce((s, it) => s + it.qty * (it.sgst + it.cgst), 0).toFixed(2);
const GRAND = +ITEMS.reduce((s, it) => s + it.tot, 0).toFixed(2);

// The production header, label for label. BR is the separator under test.
const header = (BR) => [
  "S.No",
  `Item No${BR}Description${BR}Specification${BR}Req.No`,
  `Qty${BR}U/M${BR}CUR`,
  `Ex·Price${BR}Tooling Cost${BR}P&#x26;F${BR}Others'`,
  `Excise Duty${BR}Ed. Cess${BR}S·VAT${BR}C·VAT`,
  `SGST${BR}CGST${BR}IGST${BR}UTGST`,
  `Unit Price${BR}TotAmtInspection Item`,
  "Maker",
  "DeliveryInspection Item",
  "Delivery",
];
const block = (it) => [
  [String(it.n), it.code, fmt(it.qty, 3), fmt(it.pre, 3), "0.000", fmt(it.sgst, 3), fmt(it.unit, 4), "SAMPLEMAKE", "", it.delivery],
  ["", it.desc, "NOS", "0.000", "0.000", fmt(it.cgst, 3), fmt(it.tot, 3), "", "", ""],
  ["", it.spec, "INR", "0.000", "0.000", "0.000", "", "", "", ""],
  ["", it.req, "", "0.000", "0.000", "0.000", "N", "", "", ""],
];
const tr = (cells, tag) => "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
const doc = (BR = "&#x3C;br/>", items = ITEMS) =>
  "# SAMPLE BUYER WORKS LTD\n# PURCHASE ORDER\n**OUR REF NO :** PO-QZ-0042\n\n"
  + "<table><thead>" + tr(header(BR), "th") + "</thead><tbody>\n"
  + items.flatMap(block).map((r) => tr(r, "td")).join("\n")
  + "\n</tbody></table>";

describe("stacked labels inside ONE header row (the escaped <br/> form)", () => {
  const r = normalizeFromHtml(doc());

  it("returns exactly 25 lines, one per printed S.No", () => {
    expect(r.lines).toHaveLength(25);
    expect(r.lines.map((l) => l.lineNo)).toEqual(ITEMS.map((it) => it.n));
  });

  it("reads each label at its own row offset", () => {
    r.lines.forEach((l, i) => {
      const it = ITEMS[i];
      expect(l).toMatchObject({
        customerItemCode: it.code,       // offset 0
        description: it.descText,        // offset 1
        specification: it.spec,          // offset 2
        requisition_no: it.req,          // offset 3
        quantity: it.qty,
        uom: "NOS",
        currency: "INR",
        delivery_date: it.deliveryIso,
        _record_rows: 4,
      });
    });
  });

  it("takes the proved pre-tax rate, keeps SGST and CGST on the line, and checks TotAmt", () => {
    r.lines.forEach((l, i) => {
      const it = ITEMS[i];
      expect(l.unitPrice).toBe(it.pre);
      expect(l.sgst_amount).toBe(it.sgst);
      expect(l.cgst_amount).toBe(it.cgst);
      expect(l.line_total).toBeCloseTo(it.tot, 2);
      expect(l._rate_basis).toMatchObject({ basis: "pre_tax", unit_price_printed: it.unit, total_check: "gross" });
    });
    const taxable = r.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const tax = r.lines.reduce((s, l) => s + l.quantity * (l.sgst_amount + l.cgst_amount), 0);
    expect(+taxable.toFixed(2)).toBe(TAXABLE);
    expect(+tax.toFixed(2)).toBe(GST);
    expect(+(taxable + tax).toFixed(2)).toBe(GRAND);
  });

  it("needs no fold: the record parser already joined each item's rows", () => {
    const fold = foldContinuationRows({ classification: "po", lines: r.lines }, { kind: "po" });
    expect([fold.folded, fold.headerRowsDropped]).toEqual([0, 0]);
    expect(fold.normalized.lines.some((l) => l._folded_rows)).toBe(false);
  });

  it("reports the merged rows, the header form and the glued label it read", () => {
    expect(r.diag).toMatchObject({
      tables: 1, matched: 1, misaligned: 0, continuation: 75, record_rows: 4,
      rows_considered: 25, rows_rejected: 0, max_line_no: 25, rate_pre_tax: 25,
      header_form: "stacked_cells",
    });
    expect(r.diag.glued_labels).toEqual([{ offset: 1, column: 6, printed: "TotAmtInspection Item", read_as: "TotAmt" }]);
    expect(r.diag.rate_unproven).toBeUndefined();
    expect(r.diag.total_mismatch).toBeUndefined();
  });

  it("crosses the schema boundary cleanly and raises no warning", () => {
    const { normalized, diag } = conformLines({ classification: "po", lines: r.lines, stated_line_count: 25 });
    expect(diag.unknown).toEqual([]);
    const a = detectAnomalies(normalized, { kind: "po", bodyText: "PURCHASE ORDER\nTotal Amount : INR " + fmt(GRAND, 2) });
    expect(a.anomalies.filter((x) => x.severity !== "info")).toEqual([]);
  });

  it("reads the same through normalizeFromMarkdown, the adapter's entry point", () => {
    const m = normalizeFromMarkdown(doc());
    expect(m.lines.map((l) => [l.customerItemCode, l.description, l.unitPrice]))
      .toEqual(r.lines.map((l) => [l.customerItemCode, l.description, l.unitPrice]));
  });

  it("reads the same when the stacked header cells are bare <th>, with no <tr>, pretty-printed", () => {
    // The other header shape this parser already recovers (see
    // api-llamaparse-html-tables.test.js), written one tag per line. The line
    // breaks between the tags and around a label must not count as label
    // positions: only the separators INSIDE the label text do.
    const bare = "<table><thead>\n" + header("&#x3C;br/>").map((h) => `<th>\n${h}\n</th>`).join("\n")
      + "\n</thead><tbody>\n" + ITEMS.flatMap(block).map((row) => tr(row, "td")).join("\n") + "\n</tbody></table>";
    const v = normalizeFromHtml(bare);
    expect(v.lines).toHaveLength(25);
    expect(v.lines.map((l) => [l.lineNo, l.customerItemCode, l.description, l.requisition_no, l.unitPrice]))
      .toEqual(r.lines.map((l) => [l.lineNo, l.customerItemCode, l.description, l.requisition_no, l.unitPrice]));
  });

  it.each([
    ["a real <br/>", "<br/>"],
    ["a real <br>", "<br>"],
    ["&lt;br/&gt;", "&lt;br/&gt;"],
    ["&#60;br&#62;", "&#60;br&#62;"],
    ["a newline", "\n"],
  ])("reads the same when the labels are separated by %s", (_name, BR) => {
    const v = normalizeFromHtml(doc(BR));
    expect(v.lines).toHaveLength(25);
    expect(v.lines.map((l) => [l.customerItemCode, l.description, l.specification, l.requisition_no, l.uom, l.unitPrice]))
      .toEqual(r.lines.map((l) => [l.customerItemCode, l.description, l.specification, l.requisition_no, l.uom, l.unitPrice]));
  });
});

describe("a header cell with a line break is not always a stack", () => {
  // A one-row header whose long labels WRAP, every item on one numbered row.
  // It must read exactly like the same header printed without the breaks.
  const H = ["S.No", "Item<br/>Code", "Item<br/>Description", "Qty", "UOM", "Unit<br/>Price", "Line<br/>Total"];
  const plain = H.map((h) => h.replace("<br/>", " "));
  const rows = [1, 2, 3, 4].map((n) => [String(n), "WR-" + n, "WRAPPED LABEL ITEM " + n, "2", "NOS", "150.00", "300.00"]);
  const html = (head) => "<table><thead>" + tr(head, "th") + "</thead><tbody>" + rows.map((r) => tr(r, "td")).join("") + "</tbody></table>";

  it("joins wrapped labels as before, and every numbered row stays a line", () => {
    const wrapped = normalizeFromHtml(html(H));
    expect(wrapped.lines).toHaveLength(4);
    expect(wrapped).toEqual(normalizeFromHtml(html(plain)));
    expect(wrapped.diag.header_form).toBeUndefined();
  });

  it("keeps the one-row reading when the breaks hold units, not labels, even with wrapped body rows", () => {
    // Each item wraps its description onto a second, unnumbered row, so a
    // stacked reading WOULD group the body. But "(Nos)" and "(INR)" are not
    // labels: the cells are one label each, written on two lines.
    const head = ["S.No", "Item Code", "Description", "Qty<br/>(Nos)", "Rate<br/>(INR)", "Amount<br/>(INR)"];
    const flat = head.map((h) => h.replace("<br/>", " "));
    const body = [1, 2, 3].flatMap((n) => [
      [String(n), "UN-" + n, "UNIT LABEL ITEM " + n, "2", "50.00", "100.00"],
      ["", "", "continued description " + n, "", "", ""],
    ]);
    const make = (h) => "<table><thead>" + tr(h, "th") + "</thead><tbody>" + body.map((r) => tr(r, "td")).join("") + "</tbody></table>";
    const out = normalizeFromHtml(make(head));
    expect(out.diag.header_form).toBeUndefined();
    expect(out).toEqual(normalizeFromHtml(make(flat)));
  });

  it("does not pair up items when a stacked reading would put real quantities in a lower row", () => {
    // No S.No column, and the quantity label stacks a UOM under it. Read as a
    // stack, every second item would join the one above it. Each row prints
    // its own quantity, so the stacked reading is refused.
    const head = ["Item No<br/>Description", "Description<br/>Specification", "Qty<br/>U/M", "Unit Price<br/>TotAmt"];
    const body = [1, 2, 3, 4, 5, 6].map((n) => ["PR-" + n, "PAIRED ITEM " + n, String(n), "100.00"]);
    const out = normalizeFromHtml("<table><thead>" + tr(head, "th") + "</thead><tbody>" + body.map((r) => tr(r, "td")).join("") + "</tbody></table>");
    expect(out.lines).toHaveLength(6);
    expect(out.diag.header_form).toBeUndefined();
  });
});

describe("one-row plain headers are unchanged", () => {
  // The production one-row layout, pinned field by field.
  const TH = ["Line", "Item Number", "Service Parent Name", "Item Description", "Item Specification",
    "Need By Date", "Start Date", "End Date", "Quantity", "UOM", "Unit Price", "Other Charges", "Taxes", "Line Total"];
  const cells = (n) => [String(n), `AC${100000 + n}XX01`, "-", `ACME STD SHANK PN-${n}-90-2`, "-",
    "3/31/2026", "-", "-", "1.00", "each", "1,000.80", "0.00", "180.14", "1,180.94"];
  const html = "<table><thead>" + TH.map((h) => `<th>${h}</th>`).join("") + "</thead><tbody>"
    + [1, 2].map((n) => tr(cells(n), "td")).join("") + "</tbody></table>";

  it("produces exactly the lines and diagnostics it did before", () => {
    const r = normalizeFromHtml(html);
    expect(r.lines).toEqual([1, 2].map((n) => ({
      _source: "table_columns", lineNo: n, partNumber: null, customerItemCode: `AC${100000 + n}XX01`,
      description: `ACME STD SHANK PN-${n}-90-2`, specification: null, quantity: 1, unitPrice: 1000.8,
      uom: "each", hsn: null, tax_amount: 180.14, line_total: 1180.94,
    })));
    expect(r.diag).toEqual({ tables: 1, matched: 1, continuation: 0, skipped: 0, misaligned: 0,
      rows_considered: 2, rows_rejected: 0, max_line_no: 2 });
  });
});

describe("unglue", () => {
  it.each([
    ["TotAmtInspection Item", "TotAmt"],
    ["Inspection ItemTotAmt", "TotAmt"],
    ["RemarksCUR", "CUR"],
  ])("reads %s as %s", (printed, readAs) => {
    expect(unglue(printed)).toBe(readAs);
  });

  it.each(["UnitPrice", "TotAmt", "DeliveryInspection Item", "Req.No", "Maker", "Inspection Item", ""])(
    "leaves %p alone: it matches as a whole, or holds no field", (label) => {
      expect(unglue(label)).toBeNull();
    },
  );
});
