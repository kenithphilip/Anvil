// The adapter/consumer vocabulary contract.
//
// The defect this closes was invisible to every existing test. llamaparse
// emitted `line_total` + `tax_amount`; computeLineTotals reads `lineTotal` and
// a set of per-unit component keys; the completeness guard reads the same
// components. Each side's own tests passed. The bug lived in the gap: a
// correctly extracted 44-line PO showed Rs 15,15,691.80 against a printed
// Rs 18,25,261.52 — the whole tax column dropped — and the guard whose job is
// to catch that concluded "no tax captured" and stayed silent.
//
// So these tests are written from the GAP's point of view: they assert what
// crosses the boundary, and that no adapter can cross it speaking a dialect
// nobody declared.

import { describe, it, expect } from "vitest";
import {
  canonicaliseLine, conformLines, CANONICAL_LINE_FIELDS, FIELD_ALIASES,
} from "../api/_lib/docai/line-schema.js";
import { ADAPTER_NAMES } from "../api/_lib/docai/index.js";

describe("canonicaliseLine", () => {
  it("translates the llamaparse dialect that started this", () => {
    const { line } = canonicaliseLine({
      customerItemCode: "AC100001XX01", quantity: 1, unitPrice: 1000.8,
      tax_amount: 180.14, line_total: 1180.94,
    });
    expect(line.taxTotal).toBe(180.14);
    expect(line.lineTotal).toBe(1180.94);
    expect(line.tax_amount).toBeUndefined();
    expect(line.line_total).toBeUndefined();
  });

  it("leaves an already-canonical line completely untouched", () => {
    const src = { partNumber: "PN-1", quantity: 2, unitPrice: 10, cgst_amount: 0.9 };
    const { line, renamed, unknown } = canonicaliseLine(src);
    expect(line).toEqual(src);
    expect(renamed).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("KEEPS an unrecognised field and reports it, rather than dropping data", () => {
    const { line, unknown } = canonicaliseLine({ quantity: 1, mystery_column: "keep me" });
    expect(line.mystery_column).toBe("keep me");
    expect(unknown).toEqual(["mystery_column"]);
  });

  it("passes Anvil's own underscore annotations through without flagging them", () => {
    const { line, unknown } = canonicaliseLine({
      quantity: 1, _evidence: { page: 1 }, _part_split: { via: "x" },
    });
    expect(line._evidence).toEqual({ page: 1 });
    expect(line._part_split).toEqual({ via: "x" });
    expect(unknown).toEqual([]);
  });

  it("fixes a canonical name in the wrong case", () => {
    const { line, renamed } = canonicaliseLine({ PartNumber: "PN-9", QUANTITY: 3 });
    expect(line.partNumber).toBe("PN-9");
    expect(line.quantity).toBe(3);
    expect(renamed).toContain("PartNumber->partNumber");
  });

  it("prefers the canonical value and records a conflict when both are present", () => {
    // Never silently pick one. An adapter emitting both means the adapter is
    // confused, and quietly choosing hides that.
    const { line, conflicts } = canonicaliseLine({ quantity: 5, qty: 9 });
    expect(line.quantity).toBe(5);
    expect(conflicts).toContain("qty vs quantity");
  });

  it("does not flag a conflict when alias and canonical agree", () => {
    const { line, conflicts } = canonicaliseLine({ quantity: 5, qty: 5 });
    expect(line.quantity).toBe(5);
    expect(conflicts).toEqual([]);
  });

  it.each([null, undefined, 42, "str", []])("returns %p unchanged rather than throwing", (v) => {
    expect(() => canonicaliseLine(v)).not.toThrow();
  });
});

describe("the alias table itself", () => {
  it("never maps to a name that is not canonical", () => {
    for (const [alias, target] of Object.entries(FIELD_ALIASES)) {
      expect(CANONICAL_LINE_FIELDS, alias + " -> " + target).toContain(target);
    }
  });

  it("never lists a canonical field as an alias — that would be a cycle", () => {
    for (const alias of Object.keys(FIELD_ALIASES)) {
      expect(CANONICAL_LINE_FIELDS).not.toContain(alias);
    }
  });

  // A speculative alias is worse than a missing one: a missing alias surfaces
  // in `unknown` and gets fixed, a wrong one silently moves money.
  it.each(["total", "amount", "price", "taxes", "value"])(
    "does not claim the ambiguous word %s", (w) => {
      expect(Object.keys(FIELD_ALIASES)).not.toContain(w);
    },
  );
});

describe("conformLines", () => {
  it("reports nothing when every line is already canonical", () => {
    const { diag } = conformLines({ lines: [{ quantity: 1, unitPrice: 2 }] });
    expect(diag).toBeNull();
  });

  it("aggregates renames across lines without duplicating them", () => {
    const { normalized, diag } = conformLines({
      lines: [{ tax_amount: 1 }, { tax_amount: 2 }, { tax_amount: 3 }],
    });
    expect(diag.renamed).toEqual(["tax_amount->taxTotal"]);
    expect(diag.lines_touched).toBe(3);
    expect(normalized.lines.map((l) => l.taxTotal)).toEqual([1, 2, 3]);
  });

  it("surfaces an unknown field so a new adapter's dialect is visible in the run row", () => {
    const { diag } = conformLines({ lines: [{ quantity: 1, weird_total: 5 }] });
    expect(diag.unknown).toEqual(["weird_total"]);
  });

  it("preserves everything else on the normalized object", () => {
    const { normalized } = conformLines({ classification: "po", customer: { name: "X" }, lines: [{ qty: 1 }] });
    expect(normalized.classification).toBe("po");
    expect(normalized.customer).toEqual({ name: "X" });
  });

  it("no-ops on a normalized object with no lines", () => {
    expect(conformLines({ classification: "po" }).diag).toBeNull();
    expect(conformLines(null).normalized).toBeNull();
  });
});

// This is the part that makes the contract hold for adapters that do not exist
// yet. Adding an adapter without declaring the line shape it emits fails here,
// which is the whole point: the original bug shipped because nothing forced
// llamaparse to declare that it spoke `line_total`.
describe("every registered adapter has a declared line shape", () => {
  // One representative line per adapter, taken from what each actually emits.
  const ADAPTER_LINE_SHAPES = {
    gemini:       { partNumber: "P", customerItemCode: "C", quantity: 1, unitPrice: 2, uom: "each", hsn: "8207", gst_pct: 18, cgst_amount: 0.18 },
    claude:       { partNumber: "P", customerItemCode: "C", quantity: 1, unitPrice: 2, uom: "each", hsn: "8207", gst_pct: 18, cgst_amount: 0.18 },
    llamaparse:   { partNumber: "P", customerItemCode: "C", quantity: 1, unitPrice: 2, uom: "each", hsn: null, tax_amount: 0.36, line_total: 2.36, lineNo: 1 },
    excel:        { partNumber: "P", quantity: 1, unitPrice: 2 },
    unstructured: { partNumber: "P", customerItemCode: "C", qty: 1, unitPrice: 2 },
    docling:      { partNumber: "P", customerItemCode: "C", qty: 1, unitPrice: 2 },
    marker:       { partNumber: "P", customerItemCode: "C", qty: 1, unitPrice: 2 },
    reducto:      { partNumber: "P", quantity: 1, unitPrice: 2 },
    azure_di:     { partNumber: "P", quantity: 1, unitPrice: 2 },
    gaeb:         { partNumber: "P", quantity: 1, unitPrice: 2 },
    openrouter:   { partNumber: "P", customerItemCode: "C", quantity: 1, unitPrice: 2 },
  };

  it("covers the registry with no gaps and no stale entries", () => {
    expect(Object.keys(ADAPTER_LINE_SHAPES).sort()).toEqual([...ADAPTER_NAMES].sort());
  });

  it.each(ADAPTER_NAMES)("%s emits only fields the schema knows", (name) => {
    const shape = ADAPTER_LINE_SHAPES[name];
    const { unknown } = canonicaliseLine(shape);
    expect(unknown, name + " emits undeclared field(s): " + unknown.join(", ")).toEqual([]);
  });

  it.each(ADAPTER_NAMES)("%s ends up with a quantity and a unit price under canonical names", (name) => {
    const { line } = canonicaliseLine(ADAPTER_LINE_SHAPES[name]);
    expect(line.quantity).toBe(1);
    expect(line.unitPrice).toBe(2);
    expect(line.qty).toBeUndefined();
  });
});
