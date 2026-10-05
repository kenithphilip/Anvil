// Per-line purchase requisition (PR) numbers: grouping, normalisation and the
// non-blocking notice the SO workspace shows when one PO answers several PRs.

import { describe, it, expect } from "vitest";
import {
  lineRequisition, normaliseRequisition, requisitionGroups, formatLineRanges, requisitionNotice,
} from "./requisition";

describe("lineRequisition", () => {
  it("reads and trims the line's requisition_no", () => {
    expect(lineRequisition({ requisition_no: "  1000343964 " })).toBe("1000343964");
  });

  it("stringifies a numeric value rather than dropping it", () => {
    expect(lineRequisition({ requisition_no: 1000343964 })).toBe("1000343964");
  });

  it.each([null, undefined, {}, { requisition_no: null }, { requisition_no: "   " }, "x", 7])(
    "returns null for %p", (v) => {
      expect(lineRequisition(v)).toBeNull();
    },
  );
});

describe("normaliseRequisition", () => {
  it("is the PR-number match key: upper case, letters and digits only", () => {
    expect(normaliseRequisition("1000 343 964")).toBe("1000343964");
    expect(normaliseRequisition("1000-343/964")).toBe("1000343964");
    expect(normaliseRequisition("pr-12ab")).toBe("PR12AB");
  });

  it("returns null when nothing is left", () => {
    expect(normaliseRequisition(" - / ")).toBeNull();
    expect(normaliseRequisition(null)).toBeNull();
  });
});

describe("requisitionGroups", () => {
  it("groups lines by normalised value, in order of first appearance, with 1-based line numbers", () => {
    const groups = requisitionGroups([
      { requisition_no: "1000343964" },
      { requisition_no: "1000 343 964" },
      { requisition_no: "1000344102" },
      { requisition_no: null },
      { requisition_no: "1000344102" },
    ]);
    expect(groups).toEqual([
      { key: "1000343964", value: "1000343964", lines: [1, 2] },
      { key: "1000344102", value: "1000344102", lines: [3, 5] },
    ]);
  });

  it("is empty when no line carries one", () => {
    expect(requisitionGroups([{ partNumber: "A" }, { requisition_no: "" }])).toEqual([]);
    expect(requisitionGroups(null)).toEqual([]);
  });
});

describe("formatLineRanges", () => {
  it.each([
    [[1, 2, 3, 4], "lines 1-4"],
    [[3], "line 3"],
    [[1, 2, 5], "lines 1-2, 5"],
    [[5, 1, 2, 2], "lines 1-2, 5"],
    [[1, 3, 4, 6, 7, 8], "lines 1, 3-4, 6-8"],
    [[], ""],
  ])("%p -> %p", (nums, text) => {
    expect(formatLineRanges(nums as number[])).toBe(text);
  });
});

describe("requisitionNotice", () => {
  it("names each PR with the lines that carry it when there are two", () => {
    const lines = [
      ...Array.from({ length: 4 }, () => ({ requisition_no: "1000343964" })),
      ...Array.from({ length: 5 }, () => ({ requisition_no: "1000344102" })),
    ];
    expect(requisitionNotice(requisitionGroups(lines))).toBe(
      "This PO's lines carry 2 requisition numbers: 1000343964 (lines 1-4), 1000344102 (lines 5-9).",
    );
  });

  it("says nothing for one PR, even when it is spelled two ways", () => {
    const groups = requisitionGroups([{ requisition_no: "1000343964" }, { requisition_no: "1000-343964" }]);
    expect(groups).toHaveLength(1);
    expect(requisitionNotice(groups)).toBeNull();
  });

  it("says nothing when no line carries one", () => {
    expect(requisitionNotice([])).toBeNull();
  });
});
