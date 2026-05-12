// Unit tests for src/api/_lib/docai/cross-page-tables.js (Wave 5.3).

import { describe, it, expect } from "vitest";
import {
  detectSpanningTables, planHeaderReplication, __test,
} from "../api/_lib/docai/cross-page-tables.js";

describe("__test.looksLikeHeaderRow", () => {
  it("matches a typical table header", () => {
    expect(__test.looksLikeHeaderRow("Item  Qty  Description  Rate  Amount")).toBe(true);
  });
  it("doesn't match a regular sentence", () => {
    expect(__test.looksLikeHeaderRow("Please confirm the order.")).toBe(false);
  });
});

describe("__test.looksLikeLineItemRow", () => {
  it("matches numeric-led rows", () => {
    expect(__test.looksLikeLineItemRow("1. Widget 10 NOS 100")).toBe(true);
    expect(__test.looksLikeLineItemRow("Item 3 Bend adapter")).toBe(true);
    expect(__test.looksLikeLineItemRow("12 THB-001 Bend adapter")).toBe(true);
  });
  it("doesn't match header rows", () => {
    expect(__test.looksLikeLineItemRow("Item Qty Description")).toBe(false);
  });
});

describe("detectSpanningTables", () => {
  it("returns [] on fewer than 2 pages", () => {
    expect(detectSpanningTables([{ page: 1, text: "x" }])).toEqual([]);
  });

  it("detects a table that crosses pages 2->3", () => {
    const pages = [
      { page: 1, text: "PURCHASE ORDER\nGSTIN: 27ABC" },
      { page: 2, text: "Item Qty Description Rate Amount\n1. Widget 5 10\n2. Bolt 3 20" },
      { page: 3, text: "3. Nut 6 15\n4. Adapter 7 100" },
      { page: 4, text: "Total: 1000\nSignatures" },
    ];
    const spans = detectSpanningTables(pages);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].from_page).toBe(2);
    expect(spans[0].to_page).toBe(3);
    expect(spans[0].header_page).toBe(2);
  });

  it("does not flag when the next page does not continue the table", () => {
    const pages = [
      { page: 1, text: "Item Qty Description\n1. Widget 5 10" },
      { page: 2, text: "Terms and conditions apply." },
    ];
    expect(detectSpanningTables(pages)).toEqual([]);
  });
});

describe("planHeaderReplication", () => {
  it("returns [] on empty input", () => {
    expect(planHeaderReplication([], [])).toEqual([]);
  });

  it("flags the destination chunk when span crosses chunks", () => {
    const spans = [{ from_page: 2, to_page: 3, header_page: 2 }];
    const chunks = [
      { pageStart: 1, pageEnd: 2 },
      { pageStart: 3, pageEnd: 4 },
    ];
    const out = planHeaderReplication(spans, chunks);
    expect(out.length).toBe(1);
    expect(out[0].chunk_index).toBe(1);
    expect(out[0].header_page).toBe(2);
  });

  it("skips spans whose pages land in the same chunk", () => {
    const spans = [{ from_page: 2, to_page: 3, header_page: 2 }];
    const chunks = [{ pageStart: 1, pageEnd: 4 }];
    expect(planHeaderReplication(spans, chunks)).toEqual([]);
  });
});
