// Unit tests for the diff helpers in /api/documents/correct.js. The
// HTTP handler is integration-tested elsewhere; here we pin the
// pure functions (deep diff, alias extraction) so future refactors
// don't drift the audit-log shape.

import { describe, it, expect } from "vitest";
import { __test } from "../api/documents/correct.js";

const { diffPayloads, aliasesFromDiffs } = __test;

describe("diffPayloads", () => {
  it("returns [] for identical payloads", () => {
    const a = { header: { po_number: "PO-1" }, lines: [{ part_number: "X", qty: 1 }] };
    const b = JSON.parse(JSON.stringify(a));
    expect(diffPayloads(a, b)).toEqual([]);
  });

  it("emits one diff per leaf change with bracket-index path", () => {
    const a = { header: { po_number: "PO-1" }, lines: [{ part_number: "X", qty: 1 }] };
    const b = { header: { po_number: "PO-2" }, lines: [{ part_number: "Y", qty: 1 }] };
    const diffs = diffPayloads(a, b);
    const paths = diffs.map((d) => d.field_path).sort();
    expect(paths).toEqual(["header.po_number", "lines[0].part_number"]);
  });

  it("treats null and undefined as equal", () => {
    const a = { header: { customer_name: null } };
    const b = { header: {} };
    expect(diffPayloads(a, b)).toEqual([]);
  });

  it("ignores trailing-whitespace-only string changes", () => {
    expect(diffPayloads({ x: "abc" }, { x: "abc " })).toEqual([]);
  });

  it("handles mismatched array lengths", () => {
    const a = { lines: [{ qty: 1 }] };
    const b = { lines: [{ qty: 1 }, { qty: 2 }] };
    const diffs = diffPayloads(a, b);
    expect(diffs.length).toBe(1);
    expect(diffs[0].field_path).toBe("lines[1].qty");
  });

  it("produces a stable shape for round-tripping", () => {
    const diffs = diffPayloads({ a: 1 }, { a: 2 });
    expect(diffs[0]).toEqual({ field_path: "a", from: 1, to: 2 });
  });
});

describe("aliasesFromDiffs", () => {
  it("extracts part_number diffs as alias entries", () => {
    const out = aliasesFromDiffs([
      { field_path: "lines[0].part_number", from: "BRG 6204", to: "BR-6204-ZZ" },
      { field_path: "lines[1].part_number", from: "Bearing", to: "BR-6204-ZZ" },
      { field_path: "header.po_number", from: "1", to: "2" },
    ]);
    expect(out).toEqual({
      "BRG 6204": "BR-6204-ZZ",
      "Bearing": "BR-6204-ZZ",
    });
  });

  it("ignores no-op edits and empty-from edits", () => {
    const out = aliasesFromDiffs([
      { field_path: "lines[0].part_number", from: "X", to: "X" },
      { field_path: "lines[1].part_number", from: "", to: "Y" },
      { field_path: "lines[2].part_number", from: null, to: "Z" },
    ]);
    expect(out).toEqual({});
  });

  it("ignores non-part_number paths", () => {
    const out = aliasesFromDiffs([
      { field_path: "lines[0].description", from: "old", to: "new" },
    ]);
    expect(out).toEqual({});
  });
});
