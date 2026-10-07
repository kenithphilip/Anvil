// Continuation rows: one PO item printed across several physical rows, read
// back as one line per row.
//
// The layout: each item prints its part number, quantity and price on the
// first row, then a description row, a drawing-code row and a requisition row
// below it. An extractor that reads every physical row as an item returns the
// real line followed by three "lines" with no quantity, and the first of those
// carries the item's line total in its unit-price slot. A 25-item PO came back
// with about four lines per item, and nothing downstream merged them.
//
// Every value below is invented. The fixture copies the SHAPE of the layout,
// not any document's content.

import { describe, it, expect } from "vitest";
import { foldContinuationRows, remapLineKeys, continuationReason } from "../api/_lib/docai/continuation-rows.js";
import { detectAnomalies } from "../api/_lib/docai/anomaly.js";

// Three invented items. amount = qty x rate.
const ITEMS = [
  { part: "ZX-1001-A", qty: 4, rate: 250, desc: "GUIDE BLOCK", spec: "DRW-77-01", req: "4400011122" },
  { part: "ZX-1002-B", qty: 2, rate: 1200.5, desc: "CLAMP ARM", spec: "DRW-77-02", req: "4400011122" },
  { part: "ZX-1003-C", qty: 10, rate: 19.75, desc: "SPACER RING", spec: "DRW-77-09", req: "4400033344" },
];
const amountOf = (it) => it.qty * it.rate;

// What an extractor that shreds the block returns: the part row as a line,
// then each continuation row as a line of its own. The description row picks
// up the line total (printed beside it) as its "unit price".
const shredded = (items = ITEMS) => {
  const lines = [];
  for (const it of items) {
    lines.push({ partNumber: it.part, quantity: it.qty, unitPrice: it.rate, uom: "NOS" });
    lines.push({ partNumber: it.desc, quantity: null, unitPrice: amountOf(it) });
    lines.push({ partNumber: it.spec, quantity: null, unitPrice: null });
    lines.push({ partNumber: it.req, quantity: null, unitPrice: null });
  }
  return { classification: "po", customer: { name: "Fixture Buyer" }, lines, stated_line_count: items.length };
};

describe("foldContinuationRows: N printed items in, N lines out", () => {
  it("folds a shredded 4-row-per-item block back to one line per item", () => {
    const { normalized, folded } = foldContinuationRows(shredded(), { kind: "po" });
    expect(normalized.lines.map((l) => l.partNumber)).toEqual(["ZX-1001-A", "ZX-1002-B", "ZX-1003-C"]);
    expect(folded).toBe(9);
    expect(normalized.continuation_folds).toMatchObject({ rows_folded: 9, lines_before: 12, lines_after: 3, rate_copies: 3 });
  });

  it("keeps each item's quantity and rate, and never takes the copied total as a rate", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    expect(normalized.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([[4, 250], [2, 1200.5], [10, 19.75]]);
  });

  it("puts each item's continuation text on that item, not its neighbour", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    const [a, b, c] = normalized.lines;
    expect(a.description).toBe("GUIDE BLOCK | DRW-77-01 | 4400011122");
    expect(b.description).toBe("CLAMP ARM | DRW-77-02 | 4400011122");
    expect(c.description).toBe("SPACER RING | DRW-77-09 | 4400033344");
  });

  it("keeps every folded row whole on the line it joined, with the reason", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    const rows = normalized.lines[1]._folded_rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ partNumber: "CLAMP ARM", unitPrice: 2401, _fold_reason: "rate_copies_amount_above", _source_index: 5 });
    expect(rows[1]).toMatchObject({ partNumber: "DRW-77-02", _fold_reason: "no_quantity_no_amount", _source_index: 6 });
    expect(rows[2]).toMatchObject({ partNumber: "4400011122", _source_index: 7 });
  });

  it("fills an empty specification or requisition_no from the same field, rather than the description", () => {
    const n = {
      classification: "po",
      lines: [
        { partNumber: "ZX-2001", quantity: 3, unitPrice: 40, description: "PIN" },
        { specification: "DRW-90-12" },
        { requisition_no: "4400055566" },
      ],
    };
    const [line] = foldContinuationRows(n, { kind: "po" }).normalized.lines;
    expect(line.specification).toBe("DRW-90-12");
    expect(line.requisition_no).toBe("4400055566");
    expect(line.description).toBe("PIN");
  });

  it("does not repeat text the line already carries", () => {
    const n = {
      classification: "po",
      lines: [
        { partNumber: "ZX-3001", quantity: 1, unitPrice: 75, description: "Cover plate", specification: "DRW-11-04", requisition_no: "4400077788" },
        { partNumber: "COVER PLATE" },
        { partNumber: "DRW-11-04" },
        { partNumber: "4400077788" },
      ],
    };
    const { normalized, folded } = foldContinuationRows(n, { kind: "po" });
    expect(folded).toBe(3);
    expect(normalized.lines[0].description).toBe("Cover plate");
  });

  it("recognises a copied amount that includes the per-unit taxes printed beside the rate", () => {
    const n = {
      classification: "po",
      lines: [
        { partNumber: "ZX-4001", quantity: 10, unitPrice: 100, sgst_amount: 9, cgst_amount: 9 },
        { partNumber: "BRACKET", unitPrice: 1180 },
      ],
    };
    const { normalized } = foldContinuationRows(n, { kind: "po" });
    expect(normalized.lines).toHaveLength(1);
    expect(normalized.lines[0]._folded_rows[0]._fold_reason).toBe("rate_copies_amount_above");
  });
});

describe("foldContinuationRows: rows that must survive", () => {
  const base = (extra) => ({
    classification: "po",
    lines: [{ partNumber: "ZX-5001", quantity: 2, unitPrice: 300 }, ...extra],
  });

  it("a real zero-amount line with its own quantity stays a line", () => {
    const { normalized, folded } = foldContinuationRows(base([
      { partNumber: "ZX-5002", description: "Sample, free of charge", quantity: 2, unitPrice: null },
    ]), { kind: "po" });
    expect(folded).toBe(0);
    expect(normalized.lines.map((l) => l.partNumber)).toEqual(["ZX-5001", "ZX-5002"]);
  });

  it("a row with its own quantity and its own rate is never folded, even with no part or description", () => {
    const { normalized } = foldContinuationRows(base([{ quantity: 5, unitPrice: 12 }]), { kind: "po" });
    expect(normalized.lines).toHaveLength(2);
    expect(normalized.lines[1]).toEqual({ quantity: 5, unitPrice: 12 });
  });

  it("a row with no quantity but a price of its own (not a copy) is left for review", () => {
    const { normalized } = foldContinuationRows(base([{ partNumber: "ZX-5003", unitPrice: 455 }]), { kind: "po" });
    expect(normalized.lines.map((l) => l.partNumber)).toEqual(["ZX-5001", "ZX-5003"]);
  });

  it("a row with an amount of its own is not folded", () => {
    const { normalized } = foldContinuationRows(base([{ description: "Freight", lineTotal: 900 }]), { kind: "po" });
    expect(normalized.lines).toHaveLength(2);
  });

  it("a row printing its own line number is a separate item", () => {
    const n = {
      classification: "po",
      lines: [
        { lineNo: "1", partNumber: "ZX-6001", quantity: 1, unitPrice: 10 },
        { lineNo: "2", partNumber: "ZX-6002" },
        { lineNo: "2", description: "continued text" },
      ],
    };
    const { normalized } = foldContinuationRows(n, { kind: "po" });
    expect(normalized.lines.map((l) => l.lineNo)).toEqual(["1", "2", "2"]);
  });

  it("a row with no real line above it is left alone", () => {
    const n = {
      classification: "po",
      lines: [
        { description: "Section A: spares" },
        { partNumber: "ZX-7001", quantity: 1, unitPrice: 10 },
      ],
    };
    expect(foldContinuationRows(n, { kind: "po" }).normalized.lines).toHaveLength(2);
  });

  it("does not chain through a kept line that has no quantity of its own", () => {
    const n = {
      classification: "po",
      lines: [
        { partNumber: "ZX-8001", quantity: 1, unitPrice: 10 },
        { partNumber: "ZX-8002", unitPrice: 999 },     // own price, no qty: kept for review
        { description: "orphan text" },               // the line above it is not real
      ],
    };
    expect(foldContinuationRows(n, { kind: "po" }).normalized.lines).toHaveLength(3);
  });

  it("leaves an RFQ alone: an RFQ item can legitimately print no quantity", () => {
    const n = { ...shredded(), classification: "rfq" };
    expect(foldContinuationRows(n, { kind: "po" }).normalized.lines).toHaveLength(12);
  });

  it.each(["quote", "invoice", "packing_list", "rfq"])("leaves kind %s alone", (kind) => {
    expect(foldContinuationRows(shredded(), { kind }).normalized.lines).toHaveLength(12);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = foldContinuationRows(shredded(), { kind: "po" });
    const twice = foldContinuationRows(once.normalized, { kind: "po" });
    expect(twice.folded).toBe(0);
    expect(twice.normalized).toEqual(once.normalized);
  });

  it("does not mutate its input", () => {
    const n = shredded();
    const copy = JSON.parse(JSON.stringify(n));
    foldContinuationRows(n, { kind: "po" });
    expect(n).toEqual(copy);
  });
});

describe("continuationReason", () => {
  const anchor = { partNumber: "ZX-9001", quantity: 3, unitPrice: 50 };
  it("names why a row folds", () => {
    expect(continuationReason({ description: "x" }, anchor)).toBe("no_quantity_no_amount");
    expect(continuationReason({ description: "x", unitPrice: 150 }, anchor)).toBe("rate_copies_amount_above");
  });
  it("returns null for a row with its own quantity, or under a line with none", () => {
    expect(continuationReason({ quantity: 1 }, anchor)).toBeNull();
    expect(continuationReason({ description: "x" }, { partNumber: "ZX-9002" })).toBeNull();
  });
});

describe("remapLineKeys", () => {
  it("moves per-line keys to the new index and drops the folded rows' keys", () => {
    const { keptIndices } = foldContinuationRows(shredded(), { kind: "po" });
    const conf = { overall: 0.9 };
    for (let i = 0; i < 12; i++) conf["lines[" + i + "]"] = i / 100;
    conf["lines[4].hsn"] = 0.5;
    expect(remapLineKeys(conf, keptIndices)).toEqual({
      overall: 0.9, "lines[0]": 0, "lines[1]": 0.04, "lines[2]": 0.08, "lines[1].hsn": 0.5,
    });
  });
});

describe("anomalies after a fold", () => {
  const total = ITEMS.reduce((s, it) => s + amountOf(it), 0);    // 3598.5
  const body = (printed) => "PURCHASE ORDER\nFixture Buyer\nTotal Amount : INR " + printed + "\nItem No Qty Ex Price";
  const codes = (r) => r.anomalies.map((a) => a.code);

  it("reports the fold as info, and nothing else, when the lines match the printed total", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    const r = detectAnomalies(normalized, { kind: "po", bodyText: body(total.toFixed(2)) });
    const fold = r.anomalies.find((a) => a.code === "continuation_rows_folded");
    expect(fold).toMatchObject({ severity: "info", actual: 3, expected: 12 });
    expect(codes(r)).toEqual(["continuation_rows_folded"]);
    expect(r.has_blockers).toBe(false);
  });

  it("flags a folded line set whose total disagrees with the document, in either direction", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    const over = detectAnomalies(normalized, { kind: "po", bodyText: body("3,000.00") });
    expect(over.anomalies.find((a) => a.code === "continuation_fold_total_mismatch"))
      .toMatchObject({ severity: "warn", actual: 3598.5, expected: 3000 });
    const under = detectAnomalies(normalized, { kind: "po", bodyText: body("9,000.00") });
    expect(codes(under)).toContain("continuation_fold_total_mismatch");
  });

  it("says nothing about folds on a run that folded nothing", () => {
    const n = { classification: "po", lines: [{ partNumber: "ZX-1", quantity: 1, unitPrice: 10 }] };
    const r = detectAnomalies(n, { kind: "po", bodyText: body("10.00") });
    expect(codes(r)).not.toContain("continuation_rows_folded");
  });

  it("the unfolded line set is now flagged for having more lines than the PO declares", () => {
    const r = detectAnomalies(shredded(), { kind: "po", bodyText: body(total.toFixed(2)) });
    expect(r.anomalies.find((a) => a.code === "line_count_excess"))
      .toMatchObject({ severity: "warn", actual: 12, expected: 3 });
  });

  it("the folded line set is not", () => {
    const { normalized } = foldContinuationRows(shredded(), { kind: "po" });
    expect(codes(detectAnomalies(normalized, { kind: "po" }))).not.toContain("line_count_excess");
  });

  it("line_count_excess honours its switch, its slack, and stays off non-PO kinds", () => {
    const n = shredded();
    expect(codes(detectAnomalies(n, { kind: "po", lineCountExcessEnabled: false }))).not.toContain("line_count_excess");
    expect(codes(detectAnomalies(n, { kind: "po", lineCountExcessSlack: 9 }))).not.toContain("line_count_excess");
    expect(codes(detectAnomalies(n, { kind: "po", lineCountExcessSlack: 8 }))).toContain("line_count_excess");
    expect(codes(detectAnomalies(n, { kind: "quote" }))).not.toContain("line_count_excess");
  });
});
