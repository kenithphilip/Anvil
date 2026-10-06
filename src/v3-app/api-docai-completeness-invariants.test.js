// The four completeness/correctness invariants, tested from the gap between
// components rather than inside any one of them.
//
// Context: a 44-of-45-line PO came back status `ok`, validator clean, footer
// showing Rs 15,15,691.80 against a printed Rs 18,25,261.52, and six line items
// all highlighting the same band on the PDF. Every component's own tests
// passed. Each invariant below closes one of the gaps between them, and none of
// them encodes anything about that document's layout.

import { describe, it, expect } from "vitest";
import { conformLines } from "../api/_lib/docai/line-schema.js";
import { __test as anomalyTest } from "../api/_lib/docai/anomaly.js";
import { stampEvidenceOnLines, findEvidenceForLine, buildBlockIndex } from "../api/_lib/docai/bbox-evidence.js";
import { repairLinePartCode, repairPartCodes } from "../api/_lib/docai/part-split.js";
import { __test__ as llama } from "../api/_lib/docai/llamaparse.js";

const { checkParserConservation, checkDocumentTotalShortfall, lineGross } = anomalyTest;

// ── INVARIANT 1: the vocabulary contract, end to end ───────────────────────
describe("invariant 1 — adapter dialect reaches the guard", () => {
  const bodyText = "Currency:\n \nIndian Rupee\n\nPO Total:\n \n1,825,261.52\n\nShip To:\n";
  // 44 lines as llamaparse emits them; the 45th is missing.
  const raw = Array.from({ length: 44 }, () => ({
    quantity: 1, unitPrice: 1515691.80 / 44,
    tax_amount: 272824.52 / 44, line_total: 1788516.32 / 44,
  }));

  it("stayed silent before conformance — the shipped behaviour", () => {
    // Guards the REGRESSION, not the fix: if someone teaches lineGross to read
    // `tax_amount` directly, the boundary stops being the single translation
    // point and this contract quietly rots.
    expect(checkDocumentTotalShortfall({ lines: raw }, { kind: "po", bodyText })).toHaveLength(0);
  });

  it("fires once the dispatcher has conformed the lines", () => {
    const { normalized } = conformLines({ lines: raw });
    const issues = checkDocumentTotalShortfall(normalized, { kind: "po", bodyText });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("document_total_shortfall");
  });

  it("counts absolute per-line tax without multiplying it by qty", () => {
    // The per-unit component keys ARE multiplied by qty. Conflating the two
    // would inflate a 10-unit line's tax tenfold.
    const { normalized } = conformLines({ lines: [{ quantity: 10, unitPrice: 100, tax_amount: 180, line_total: 1180 }] });
    const g = lineGross(normalized.lines[0]);
    expect(g.taxable).toBe(1000);
    expect(g.gross).toBe(1180);
    expect(g.taxSeen).toBe(true);
  });

  it("still multiplies genuine per-unit components by qty", () => {
    const g = lineGross({ quantity: 2, unitPrice: 100, cgst_amount: 9, sgst_amount: 9 });
    expect(g.gross).toBe(236);
  });
});

// ── INVARIANT 2: conservation ──────────────────────────────────────────────
describe("invariant 2 — rows accepted must equal lines emitted", () => {
  it("is silent when nothing was lost", () => {
    expect(checkParserConservation({
      parse_conservation: { rows_considered: 18, lines_emitted: 18, rows_misaligned: 0, max_line_no: 18 },
    })).toHaveLength(0);
  });

  it("reports rows dropped by our own furniture guard", () => {
    const [i] = checkParserConservation({
      parse_conservation: { rows_considered: 20, lines_emitted: 18, rows_misaligned: 0 },
    });
    expect(i.code).toBe("parser_conservation_gap");
    expect(i.expected).toBe(20);
    expect(i.actual).toBe(18);
  });

  it("reports rows the parser refused to align rather than emit shifted", () => {
    const [i] = checkParserConservation({
      parse_conservation: { rows_considered: 18, lines_emitted: 18, rows_misaligned: 3 },
    });
    expect(i.code).toBe("parser_rows_misaligned");
  });

  it("escalates to an error when the document numbers past what we produced", () => {
    const [i] = checkParserConservation({
      parse_conservation: { rows_considered: 44, lines_emitted: 44, rows_misaligned: 0, max_line_no: 45 },
    });
    expect(i.code).toBe("printed_line_number_gap");
    expect(i.severity).toBe("error");
    expect(i.expected).toBe(45);
  });

  // The honest limit, pinned so nobody later mistakes this for total coverage.
  it("cannot see a row the parser never received — that is the total check's job", () => {
    expect(checkParserConservation({
      parse_conservation: { rows_considered: 44, lines_emitted: 44, rows_misaligned: 0, max_line_no: 44 },
    })).toHaveLength(0);
  });

  it("no-ops entirely for adapters that report no conservation block", () => {
    expect(checkParserConservation({ lines: [{ quantity: 1 }] })).toHaveLength(0);
  });

  it("the llamaparse parser actually populates the counters", () => {
    const TH = ["Line", "Item Number", "Item Description", "Quantity", "UOM", "Unit Price", "Taxes", "Line Total"];
    const row = (n) => `<tr>${[n, `AC${n}`, "WIDGET", "1.00", "each", "10.00", "1.80", "11.80"].map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const doc = `<table><thead><tr><th colspan="8">Line Details</th></tr><tr>${TH.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`
      + `<tbody>${[1, 2, 3].map(row).join("")}</tbody></table>`;
    const r = llama.normalizeFromHtml(doc);
    expect(r.lines).toHaveLength(3);
    expect(r.diag.rows_considered).toBe(3);
    expect(r.diag.rows_rejected).toBe(0);
    expect(r.diag.max_line_no).toBe(3);
    expect(r.lines[0].lineNo).toBe(1);
  });

  it("reads the Line column without stealing it from Line Total", () => {
    const TH = ["Line", "Item Number", "Quantity", "Unit Price", "Line Total"];
    const doc = `<table><thead><tr>${TH.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`
      + `<tbody><tr><td>7</td><td>AC7</td><td>1.00</td><td>10.00</td><td>11.80</td></tr></tbody></table>`;
    const l = llama.normalizeFromHtml(doc).lines[0];
    expect(l.lineNo).toBe(7);
    expect(l.line_total).toBe(11.8);
  });
});

// ── INVARIANT 3: geometry assignment ───────────────────────────────────────
describe("invariant 3 — one block backs at most one line", () => {
  const layer = { raw_pages: [{ index: 0, width: 600, height: 800, blocks: [
    { text: "ACME STD SHANK PN- AC100001XX01 1.00 each", bbox: [10, 100, 500, 112], confidence: 1 },
    { text: "ACME STD SHANK PN- AC100002XX01 1.00 each", bbox: [10, 120, 500, 132], confidence: 1 },
    { text: "ACME STD SHANK PN- AC100003XX01 1.00 each", bbox: [10, 140, 500, 152], confidence: 1 },
    { text: "Supplier Name ACME LTD", bbox: [10, 300, 400, 312], confidence: 1 },
  ] }] };
  const mkLines = () => [1, 2, 3].map((n) => ({
    customerItemCode: `AC10000${n}XX01`, description: "ACME STD SHANK PN-", quantity: 1, unitPrice: 100,
  }));

  it("gives identical-description lines DISTINCT boxes", () => {
    // The reported symptom: six consecutive lines shared one bbox because they
    // tokenised identically and the tie broke to document order.
    const lines = mkLines();
    stampEvidenceOnLines({ lines }, layer);
    const boxes = lines.map((l) => JSON.stringify(l._evidence?.bbox));
    expect(new Set(boxes).size).toBe(lines.length);
  });

  it("puts each line on ITS OWN row, not merely a different one", () => {
    const lines = mkLines();
    stampEvidenceOnLines({ lines }, layer);
    expect(lines[0]._evidence.bbox).toEqual([10, 100, 500, 112]);
    expect(lines[1]._evidence.bbox).toEqual([10, 120, 500, 132]);
    expect(lines[2]._evidence.bbox).toEqual([10, 140, 500, 152]);
  });

  it("uses customerItemCode — the field the old matcher never read", () => {
    const blocks = buildBlockIndex(layer);
    const ev = findEvidenceForLine({ customerItemCode: "AC100002XX01" }, blocks);
    expect(ev.bbox).toEqual([10, 120, 500, 132]);
  });

  it("weights a rare identifier above repeated generic words", () => {
    const blocks = buildBlockIndex(layer);
    // "acme std shank" matches every row; the code matches exactly one. Raw
    // overlap counting picked the first row for all of them.
    const ev = findEvidenceForLine({ description: "ACME STD SHANK PN-", customerItemCode: "AC100003XX01" }, blocks);
    expect(ev.bbox).toEqual([10, 140, 500, 152]);
  });

  it("leaves a line UNSTAMPED rather than reusing a claimed block", () => {
    // A wrong highlight is worse than none: the operator trusts it.
    const lines = [...mkLines(), { customerItemCode: "AC100001XX01", description: "ACME STD SHANK PN-" }];
    stampEvidenceOnLines({ lines }, layer);
    const used = lines.filter((l) => l._evidence).map((l) => JSON.stringify(l._evidence.bbox));
    expect(new Set(used).size).toBe(used.length);
  });

  it("never reassigns geometry the parser supplied", () => {
    const parserEv = { page: 9, bbox: [1, 2, 3, 4], bbox_norm: [0, 0, 1, 1], source: "parser" };
    const lines = [{ customerItemCode: "AC100001XX01", _evidence: parserEv }];
    stampEvidenceOnLines({ lines }, layer);
    expect(lines[0]._evidence).toBe(parserEv);
  });

  it("is deterministic — the same document yields the same overlay", () => {
    const a = mkLines(); stampEvidenceOnLines({ lines: a }, layer);
    const b = mkLines(); stampEvidenceOnLines({ lines: b }, layer);
    expect(a.map((l) => l._evidence?.bbox)).toEqual(b.map((l) => l._evidence?.bbox));
  });
});

// ── INVARIANT 4: structured columns beat prose ─────────────────────────────
describe("invariant 4 — never re-derive a value the columns already answered", () => {
  it("does not mine a table line's description for a part number", () => {
    // The splitter turned "OBARA STD SHANK TWS-092- 90-2" into partNumber
    // "90-2" — the tail of a hyphenated code cut in half by a cell line-wrap.
    const line = { _source: "table_columns", partNumber: null, customerItemCode: "AC100001XX01", description: "ACME STD SHANK PN-092- 90-2" };
    const out = repairLinePartCode(line, {});
    expect(out).toBe(line);
    expect(out.partNumber).toBeNull();
    expect(out._part_split).toBeUndefined();
  });

  it("still repairs a PROSE line, which is what the splitter is for", () => {
    const out = repairLinePartCode({ partNumber: null, description: "ACME STD SHANK PN-092-90-2" }, {});
    expect(out.partNumber).toBeTruthy();
    expect(out._part_split).toBeTruthy();
  });

  it("leaves a structured line alone across the whole-extraction helper too", () => {
    const { normalized, repaired } = repairPartCodes({
      lines: [
        { _source: "table_columns", partNumber: null, description: "ACME STD SHANK PN-092- 90-2" },
        { partNumber: null, description: "ACME STD SHANK PN-092-90-2" },
      ],
    }, {});
    expect(repaired).toBe(1);
    expect(normalized.lines[0].partNumber).toBeNull();
    expect(normalized.lines[1].partNumber).toBeTruthy();
  });

  it("marks table-parsed lines with the provenance that drives this", () => {
    const TH = ["Item Number", "Item Description", "Quantity", "Unit Price"];
    const doc = `<table><thead><tr>${TH.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`
      + `<tbody><tr><td>AC1</td><td>WIDGET</td><td>1.00</td><td>10.00</td></tr></tbody></table>`;
    expect(llama.normalizeFromHtml(doc).lines[0]._source).toBe("table_columns");
  });

  it("keeps provenance out of the canonical vocabulary check", () => {
    // Underscore keys are Anvil's own annotations, not document data.
    const { unknown } = conformLines({ lines: [{ _source: "table_columns", quantity: 1 }] });
    expect(unknown).toBeUndefined();
  });
});
