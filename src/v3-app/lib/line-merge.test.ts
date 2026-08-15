// Extraction must not destroy what it did not produce.
//
// Two real failures:
//
//   P0 — a failed run BLANKED the order. runExtraction wrote `lineItems: lines`
//        unconditionally, so a run returning nothing replaced good data with an
//        empty array. A live order lost 44 extracted lines exactly this way.
//        The server's chunked path had already been hardened against it; the
//        synchronous client path never was.
//
//   P1 — re-extraction would erase operator work. Anything a sales engineer
//        adds by hand is invisible to the next extraction, so a wholesale
//        replace deletes it. Without this, manual entry is a trap.

import { describe, it, expect } from "vitest";
import { mergeExtractedLines, lineIdentity, originOf, isOperatorLine } from "./line-merge";

const extracted = (code: string, extra: Record<string, unknown> = {}) =>
  ({ customerItemCode: code, quantity: 1, unitPrice: 100, ...extra });
const operator = (code: string, origin = "operator_recovered", extra: Record<string, unknown> = {}) =>
  ({ customerItemCode: code, quantity: 1, unitPrice: 100, _origin: origin, ...extra });

describe("origin", () => {
  it("treats a line with no _origin as extractor output", () => {
    // Every line that predates this field came from the extractor.
    expect(originOf({ customerItemCode: "A1" })).toBe("extracted");
    expect(isOperatorLine({ customerItemCode: "A1" })).toBe(false);
  });

  it.each(["operator_recovered", "quote_variance"])("recognises %s as operator-entered", (o) => {
    expect(originOf({ _origin: o })).toBe(o);
    expect(isOperatorLine({ _origin: o })).toBe(true);
  });

  it("ignores an unrecognised origin rather than trusting it", () => {
    expect(originOf({ _origin: "something_else" })).toBe("extracted");
  });

  it.each([null, undefined])("handles %p", (v) => {
    expect(originOf(v)).toBe("extracted");
  });
});

describe("lineIdentity", () => {
  it("prefers the customer item code", () => {
    expect(lineIdentity({ customerItemCode: "A-1", partNumber: "P-9" })).toBe("code:a1");
  });

  it("falls back to the part number", () => {
    expect(lineIdentity({ partNumber: "TWS-092-90-2" })).toBe("part:tws092902");
  });

  it("falls back to description plus quantity", () => {
    expect(lineIdentity({ description: "ACME SHANK", quantity: 2 })).toBe("desc:acmeshank|2");
  });

  it("distinguishes the same description at different quantities", () => {
    expect(lineIdentity({ description: "X", quantity: 1 }))
      .not.toBe(lineIdentity({ description: "X", quantity: 2 }));
  });

  // A null identity can never supersede an operator line — the safe direction.
  it("returns null for a line carrying nothing identifying", () => {
    expect(lineIdentity({ quantity: 1, unitPrice: 5 })).toBeNull();
    expect(lineIdentity(null)).toBeNull();
  });
});

describe("P1 — operator lines survive re-extraction", () => {
  it("carries forward a hand-added line the extractor still cannot see", () => {
    const prev = [extracted("A1"), operator("A45")];
    const next = [extracted("A1"), extracted("A2")];
    const r = mergeExtractedLines(prev, next);
    expect(r.lines.map((l) => l.customerItemCode)).toEqual(["A1", "A2", "A45"]);
    expect(r.preserved).toBe(1);
    expect(r.superseded).toBe(0);
  });

  it("carries forward a quote_variance line, which extraction can NEVER find", () => {
    // A variance line is not on the PO by definition.
    const r = mergeExtractedLines([operator("Q1", "quote_variance")], [extracted("A1")]);
    expect(r.lines).toHaveLength(2);
    expect(r.preserved).toBe(1);
  });

  it("drops the operator copy once extraction reports the same line", () => {
    // Most often the customer amended the PO. Keeping both would double-count
    // the value on the order.
    const r = mergeExtractedLines([extracted("A1"), operator("A45")], [extracted("A1"), extracted("A45")]);
    expect(r.lines).toHaveLength(2);
    expect(r.superseded).toBe(1);
    expect(r.preserved).toBe(0);
    // and the surviving copy is the EXTRACTED one
    expect(r.lines.every((l) => !l._origin)).toBe(true);
  });

  it("matches on part number when there is no item code", () => {
    const prev = [{ partNumber: "TWS-092-90-2", _origin: "operator_recovered" }];
    const next = [{ partNumber: "TWS-092-90-2" }];
    expect(mergeExtractedLines(prev, next).superseded).toBe(1);
  });

  it("keeps an unidentifiable operator line rather than guessing it away", () => {
    const r = mergeExtractedLines([{ quantity: 1, _origin: "operator_recovered" }], [extracted("A1")]);
    expect(r.preserved).toBe(1);
  });

  it("replaces extracted lines wholesale — extraction owns those", () => {
    const r = mergeExtractedLines([extracted("OLD1"), extracted("OLD2")], [extracted("NEW1")]);
    expect(r.lines.map((l) => l.customerItemCode)).toEqual(["NEW1"]);
  });

  it("is a no-op when the order has no operator lines", () => {
    const next = [extracted("A1"), extracted("A2")];
    expect(mergeExtractedLines([extracted("OLD")], next).lines).toEqual(next);
  });

  it("puts fresh lines first and carried lines after, so order is stable", () => {
    const r = mergeExtractedLines([operator("Z9")], [extracted("A1"), extracted("A2")]);
    expect(r.lines.map((l) => l.customerItemCode)).toEqual(["A1", "A2", "Z9"]);
  });

  it.each([[null], [undefined], [[]]])("survives prev = %p", (prev: any) => {
    expect(mergeExtractedLines(prev, [extracted("A1")]).lines).toHaveLength(1);
  });

  it("never mutates the arrays it is given", () => {
    const prev = [operator("A45")];
    const next = [extracted("A1")];
    mergeExtractedLines(prev, next);
    expect(prev).toHaveLength(1);
    expect(next).toHaveLength(1);
  });
});

describe("P0 — the empty-result contract", () => {
  // The caller does not call merge at all when the run extracted nothing; the
  // guard lives at the call site. This pins the shape merge returns if it ever
  // IS called that way, so a future refactor cannot silently blank an order.
  it("returns only carried operator lines when next is empty", () => {
    const r = mergeExtractedLines([extracted("A1"), operator("A45")], []);
    // Extracted lines are gone because extraction is authoritative for them —
    // which is exactly why the CALLER must not invoke this on a failed run.
    expect(r.lines.map((l) => l.customerItemCode)).toEqual(["A45"]);
  });

  it("returns nothing at all for two empty inputs", () => {
    expect(mergeExtractedLines([], []).lines).toEqual([]);
  });
});
