// Unit tests for the pure GRN receipt math (Logistics Ops P2).
// Model: ap_goods_receipts is the ledger; source_po_lines.received_qty is a
// projection = sum of the ledger. Also asserts the part-number join key so the
// received qty actually reaches the AP 3-way match.
import { describe, it, expect } from "vitest";
import { applyReceipt, sumReceiptLines, projectReceipt } from "../api/_lib/logistics/receiving.js";

const NOW = "2026-07-14T00:00:00.000Z";
const poLines = [
  { id: "l1", line_index: 1, part_no: "ABC-1", qty: 10, received_qty: 0 },
  { id: "l2", line_index: 2, part_no: "ABC-2", qty: 5, received_qty: 0 },
];

describe("applyReceipt (validate + build GRN lines)", () => {
  it("keys po_line_ref by PART NUMBER so it joins to the AP invoice side", () => {
    const { grnLines } = applyReceipt(poLines, [{ line_index: 1, received_qty: 4 }]);
    expect(grnLines[0]).toMatchObject({ line_index: 1, po_line_ref: "ABC-1", part_no: "ABC-1", received_qty: 4, ordered_qty: 10 });
    // po_line_ref must NOT be the integer line_index (the bug the review caught).
    expect(grnLines[0].po_line_ref).not.toBe(1);
  });

  it("pre-sums two inputs for the same line into one GRN line (no clobber)", () => {
    const { grnLines } = applyReceipt(poLines, [
      { line_index: 1, received_qty: 5 },
      { line_index: 1, received_qty: 3 },
    ]);
    expect(grnLines).toHaveLength(1);
    expect(grnLines[0].received_qty).toBe(8);
  });

  it("rejects bad inputs (unknown line, non-positive qty) per-line", () => {
    const { grnLines, errors } = applyReceipt(poLines, [
      { line_index: 9, received_qty: 3 },
      { line_index: 1, received_qty: 0 },
      { line_index: 2, received_qty: 5 },
    ]);
    expect(errors).toEqual([
      { line_index: 9, error: "no such line_index" },
      { line_index: 1, error: "received_qty must be > 0" },
    ]);
    expect(grnLines).toEqual([{ line_index: 2, po_line_ref: "ABC-2", part_no: "ABC-2", received_qty: 5, ordered_qty: 5 }]);
  });
});

describe("sumReceiptLines (ledger projection input)", () => {
  it("sums received_qty across all receipts by line_index", () => {
    const receipts = [
      { lines: [{ line_index: 1, received_qty: 4 }, { line_index: 2, received_qty: 5 }] },
      { lines: [{ line_index: 1, received_qty: 6 }] },
    ];
    const totals = sumReceiptLines(receipts);
    expect(totals.get(1)).toBe(10);
    expect(totals.get(2)).toBe(5);
  });
});

describe("projectReceipt (received_qty is a projection of the ledger)", () => {
  it("marks fully received only when every ordered line is met by the ledger", () => {
    const receipts = [{ lines: [{ line_index: 1, received_qty: 10 }, { line_index: 2, received_qty: 5 }] }];
    const r = projectReceipt(poLines, receipts, NOW);
    expect(r.fullyReceived).toBe(true);
    expect(r.updates).toEqual([
      { id: "l1", line_index: 1, received_qty: 10, received_at: NOW },
      { id: "l2", line_index: 2, received_qty: 5, received_at: NOW },
    ]);
    expect(r.overReceived).toEqual([]);
  });

  it("stays partial and only updates changed lines", () => {
    const receipts = [{ lines: [{ line_index: 1, received_qty: 4 }] }];
    const r = projectReceipt(poLines, receipts, NOW);
    expect(r.fullyReceived).toBe(false);
    expect(r.updates).toEqual([{ id: "l1", line_index: 1, received_qty: 4, received_at: NOW }]); // l2 unchanged, omitted
  });

  it("flags over-receipt from the ledger sum", () => {
    const receipts = [{ lines: [{ line_index: 2, received_qty: 7 }] }];
    const r = projectReceipt(poLines, receipts, NOW);
    expect(r.overReceived).toEqual([{ line_index: 2, ordered_qty: 5, received_qty: 7 }]);
    expect(r.fullyReceived).toBe(false);
  });

  it("does not report fullyReceived for an empty PO", () => {
    expect(projectReceipt([], [{ lines: [{ line_index: 1, received_qty: 1 }] }], NOW).fullyReceived).toBe(false);
  });
});
