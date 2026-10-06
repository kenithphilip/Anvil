// Auto-fill always claimed it had done nothing.
//
// `filled`, `matchedGuns` and `emptyGuns` were declared in the enclosing scope
// and incremented INSIDE a `dirty(...)` callback — a setDraft updater. React
// runs an updater during the following render, not at the call site, so the very
// next synchronous line read them while still 0 and the toast said
//
//   "0 cells filled across 0 gun(s)."
//
// every single time. The fill itself worked. An operator had no way to tell
// that from a feature that silently did nothing, which is worse than an error.
//
// computeAutoFill returns the counts WITH the rows, so the number reported is
// the number produced and cannot drift from it again.

import { describe, it, expect } from "vitest";
import { computeAutoFill } from "./spare-match";
import type { SpareBomItem } from "./spare-match";

// matchSpares matches on `part_name` (not `description`), so the fixture has to
// carry it — a BOM line without one can never match any column.
const bom = (parts: Array<[string, string]>): SpareBomItem[] =>
  parts.map(([part_no, part_name]) => ({ part_no, part_name } as SpareBomItem));

// Two guns, one with a BOM that matches the TIP and SHUNT columns, one absent.
const LINES = new Map<string, SpareBomItem[]>([
  ["GUN-1", bom([["TIP-101", "TIP"], ["SHUNT-9", "SHUNT"]])],
]);
const rows = () => [
  { gun_no: "GUN-1", values: {} },
  { gun_no: "GUN-2", values: {} },
];

describe("computeAutoFill", () => {
  it("reports a non-zero count when it fills something", () => {
    // The regression, stated directly.
    const out = computeAutoFill(rows(), ["TIP", "SHUNT"], LINES);
    expect(out.filled).toBeGreaterThan(0);
    expect(out.matchedGuns).toBe(1);
  });

  it("counts a gun with no BOM as empty, not as matched", () => {
    const out = computeAutoFill(rows(), ["TIP", "SHUNT"], LINES);
    expect(out.emptyGuns).toBe(1);
  });

  it("returns the filled rows alongside the counts", () => {
    // Same object, so the toast and the grid cannot disagree.
    const out = computeAutoFill(rows(), ["TIP", "SHUNT"], LINES);
    const gun1 = out.rows.find((r: any) => r.gun_no === "GUN-1");
    const changed = Object.keys(gun1.values).length;
    expect(changed).toBe(out.filled);
  });

  it("counts only genuine changes, so a re-run reports zero", () => {
    // Re-running on an already-filled matrix must not re-report the whole grid.
    const first = computeAutoFill(rows(), ["TIP", "SHUNT"], LINES);
    const second = computeAutoFill(first.rows, ["TIP", "SHUNT"], LINES);
    expect(first.filled).toBeGreaterThan(0);
    expect(second.filled).toBe(0);
    expect(second.matchedGuns).toBe(0);
  });

  it("never writes a locked column", () => {
    const out = computeAutoFill(rows(), ["TIP", "SHUNT"], LINES, new Set(["TIP"]));
    const gun1 = out.rows.find((r: any) => r.gun_no === "GUN-1");
    expect(gun1.values.TIP).toBeUndefined();
  });

  it("leaves an unmatched row untouched by identity", () => {
    // A gun with no BOM should come back as the SAME object, so React skips it.
    const input = rows();
    const out = computeAutoFill(input, ["TIP"], LINES);
    expect(out.rows[1]).toBe(input[1]);
  });

  it("does not mutate the input rows", () => {
    const input = rows();
    computeAutoFill(input, ["TIP", "SHUNT"], LINES);
    expect(input[0].values).toEqual({});
  });

  it("matches the gun code case-insensitively", () => {
    const out = computeAutoFill([{ gun_no: "gun-1", values: {} }], ["TIP"], LINES);
    expect(out.filled).toBeGreaterThan(0);
  });

  it.each([[[]], [null], [undefined]])("handles %p rows", (v) => {
    const out = computeAutoFill(v as any, ["TIP"], LINES);
    expect(out).toMatchObject({ filled: 0, matchedGuns: 0, emptyGuns: 0 });
    expect(out.rows).toEqual([]);
  });

  it("handles a row with no gun number or values", () => {
    const out = computeAutoFill([{}, { gun_no: "GUN-1" }] as any, ["TIP"], LINES);
    expect(out.emptyGuns).toBe(1);          // the {} row
    expect(out.matchedGuns).toBe(1);        // GUN-1, despite no values object
  });

  it("reports zero when there are no columns to fill", () => {
    const out = computeAutoFill(rows(), [], LINES);
    expect(out.filled).toBe(0);
  });
});
