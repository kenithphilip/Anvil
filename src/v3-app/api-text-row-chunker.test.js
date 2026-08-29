// Pure row-window planner for density-aware chunking. No I/O, no model.

import { describe, it, expect } from "vitest";
import {
  planRowWindows, shouldRowChunk, buildWindowBodyText, leadingItemNumber, __test, __consts__,
} from "../api/_lib/docai/text-row-chunker.js";

// A FIAT-ARC-like quote: preamble, a stacked 2-line header, N single-row items
// (with a numbering gap like the real doc's jump to 202+), then a terms tail.
const fiatLike = (n = 50) => {
  const preamble = [
    "                              PRICE QUOTATION",
    "No : OIQTLC-260327-FIAT-CONSUMABLES-ARC-2026-2027-Rev-2",
    "TO: Fiat India Automobiles Limited",
    "CURRENCY : INR",
  ];
  const header = [
    " Item   Part Name   PARTS NO.   DRAWING /CUSTOMER NUMBER   REMARK   HSN CODE   Qty Unit   Unit Price   Amount",
    "                                                                              DISCOUNTED PRICE      GST  CGST SGST IGST",
  ];
  const rows = [];
  for (let i = 1; i <= n; i++) {
    // mimic the real doc's gap: last few items jump into the 200s
    const num = i <= n - 6 ? i : 200 + (i - (n - 6));
    rows.push(`  ${num}   ADAPTER   TNA-16-04-${i}-2   CAP100588${i}   SRTC-2C98${i}L   85159000   5 Nos ₹ 660 ₹ 3,300 ₹ 620 ₹ 3,100   9%   9%`);
    rows.push(""); // blank line between items, like pdftotext -layout
  }
  const tail = ["", "", "Terms & Conditions:", "1) Prices are ex-works.", "Your's Faithfully, OBARA INDIA PVT LTD"];
  return [...preamble, "", ...header, "", ...rows, ...tail].join("\n");
};

describe("leadingItemNumber", () => {
  it("reads the S.No / Item column, ignores prose and indented rows", () => {
    expect(leadingItemNumber("  12   ADAPTER   TNA-1")).toBe(12);
    expect(leadingItemNumber("207) Holder  HDC-0993")).toBe(207);
    expect(leadingItemNumber("      ATD NS HEAD ASSY   EA")).toBeNull();
    expect(leadingItemNumber("1) Prices are ex-works.")).toBe(1); // leading-number prose is caught...
    expect(leadingItemNumber("CURRENCY : INR")).toBeNull();
  });
});

describe("shouldRowChunk", () => {
  it("true for a dense table, false for a small one", () => {
    expect(shouldRowChunk(fiatLike(50))).toBe(true);
    expect(shouldRowChunk(fiatLike(10))).toBe(false);
    expect(shouldRowChunk("just some prose\nwith no table")).toBe(false);
    expect(shouldRowChunk(null)).toBe(false);
  });
});

describe("planRowWindows (FIAT-like single-row dense table)", () => {
  const plan = planRowWindows(fiatLike(50), { maxItemsPerWindow: 20 });

  it("finds the table, counts items, splits into ceil(50/20)=3 windows", () => {
    expect(plan.tableFound).toBe(true);
    expect(plan.itemCount).toBe(50);
    expect(plan.windows.length).toBe(3);
    expect(plan.windows.map((w) => w.itemCount)).toEqual([20, 20, 10]);
  });

  it("captures the preamble (customer/quote) and the stacked header", () => {
    expect(plan.preamble).toContain("Fiat India Automobiles Limited");
    expect(plan.preamble).toContain("OIQTLC-260327");
    expect(plan.header).toMatch(/PARTS NO\./);
    expect(plan.header).toMatch(/DISCOUNTED PRICE/); // both header lines captured
  });

  it("every window carries the header (so a mid-table window is still extractable)", () => {
    for (const w of plan.windows) {
      expect(w.text).toMatch(/PARTS NO\./);
    }
  });

  it("buildWindowBodyText prepends the preamble to each window", () => {
    const body = buildWindowBodyText(plan, plan.windows[2]); // the LAST window
    expect(body).toContain("Fiat India Automobiles Limited"); // context present
    expect(body).toMatch(/PARTS NO\./);                        // header present
    expect(body).toContain("TNA-16-04-45-2");                  // a row from the last window
  });

  it("does not leak the terms tail into an item window", () => {
    const all = plan.windows.map((w) => w.text).join("\n");
    expect(all).not.toContain("Prices are ex-works");
  });

  it("window boundaries fall only on item rows (no item split across windows)", () => {
    // the first line of each window's ROW section is an item row
    for (const w of plan.windows) {
      const firstRow = w.text.split("\n").find((l) => l && !/PARTS NO\.|DISCOUNTED/.test(l));
      expect(leadingItemNumber(firstRow)).not.toBeNull();
    }
  });
});

describe("planRowWindows (multi-physical-row-per-item)", () => {
  // Each item = 4 physical rows; only the first carries the S.No.
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push(`  ${i}   GD5442025030600${i}   1.000   45,408.000   4,086.720`);
    rows.push("      ATD NS HEAD ASSY   EA   0.000");
    rows.push(`      AS2-00${i}   INR   0.000`);
    rows.push("      1000343964   0.000   N");
  }
  const text = [
    "PURCHASE ORDER  P250432265",
    "S.No  Item No  Qty  Ex-Price  SGST",
    ...rows,
  ].join("\n");

  it("groups 4 physical rows per item and splits on item boundaries", () => {
    const plan = planRowWindows(text, { maxItemsPerWindow: 5 });
    expect(plan.itemCount).toBe(12);
    expect(plan.windows.map((w) => w.itemCount)).toEqual([5, 5, 2]);
    // each window's block keeps its 4 physical rows together
    const firstBlock = plan.windows[0].text.split("\n");
    expect(firstBlock.join("\n")).toContain("ATD NS HEAD ASSY");
    expect(firstBlock.join("\n")).toContain("1000343964");
  });
});

describe("planRowWindows (edges)", () => {
  it("no table -> tableFound false, caller falls back to single-shot", () => {
    const plan = planRowWindows("Dear sir,\nplease find our offer attached.\nRegards.");
    expect(plan.tableFound).toBe(false);
    expect(plan.windows.length).toBe(0);
  });

  it("items but no recognizable header -> still windows, empty header", () => {
    const text = ["1  WIDGET  5  100", "2  GADGET  3  200", "3  GIZMO  1  300"].join("\n");
    const plan = planRowWindows(text, { maxItemsPerWindow: 2 });
    expect(plan.tableFound).toBe(true);
    expect(plan.itemCount).toBe(3);
    expect(plan.windows.length).toBe(2);
  });

  it("null/garbage input is safe", () => {
    expect(planRowWindows(null).tableFound).toBe(false);
    expect(planRowWindows(42).tableFound).toBe(false);
  });

  it("drops a terms tail separated by only ONE blank line", () => {
    // pdftotext -layout usually emits a single blank separator; requiring a
    // DOUBLE blank glued the whole T&C block onto the last window.
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(`  ${i}  WIDGET-${i}  5  100`);
    const text = [
      "QUOTATION", "TO: Someone Ltd", "",
      " Item  Description  Qty  Rate", "",
      ...rows,
      "",                                   // single blank, then the tail
      "Terms & Conditions:",
      "1) Prices are ex-works our factory.",
      "Your's Faithfully",
    ].join("\n");
    const plan = planRowWindows(text, { maxItemsPerWindow: 6 });
    expect(plan.itemCount).toBe(12);
    const all = plan.windows.map((w) => w.text).join("\n");
    expect(all).not.toContain("Prices are ex-works");
    expect(all).not.toContain("Faithfully");
    expect(all).toContain("WIDGET-12"); // the last item is still kept
  });

  it("keeps a multi-row item's continuation rows when a blank follows the block", () => {
    // The last item's own physical rows are non-blank and precede the blank, so
    // cutting at the first blank must not truncate them.
    const text = [
      "PURCHASE ORDER", "S.No  Item  Qty  Rate", "",
      "  1  PART-1  1  10", "     DESCRIPTION LINE 1", "     SPEC-1",
      "  2  PART-2  1  20", "     DESCRIPTION LINE 2", "     SPEC-2",
      "", "Terms: net 30",
    ].join("\n");
    const plan = planRowWindows(text, { maxItemsPerWindow: 10 });
    expect(plan.itemCount).toBe(2);
    const all = plan.windows.map((w) => w.text).join("\n");
    expect(all).toContain("DESCRIPTION LINE 2"); // continuation kept
    expect(all).toContain("SPEC-2");
    expect(all).not.toContain("Terms: net 30");  // tail dropped
  });

  it("exposes tunables", () => {
    expect(__consts__.DEFAULT_MAX_ITEMS_PER_WINDOW).toBeGreaterThan(0);
    expect(__consts__.DEFAULT_MIN_ITEMS_TO_CHUNK).toBeGreaterThan(0);
    expect(typeof __test.looksLikeHeaderRow).toBe("function");
  });
});
