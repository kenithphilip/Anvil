// Gap -> variance line.
//
// The values come from the QUOTE, not the customer's PO. That is the whole
// reason this line is different: the buyer has not ordered it, so it must be
// stamped quote_variance — which renders as "not on PO", is refused by the
// Tally push, and survives re-extraction because extraction can never find a
// line that is not in the document.

import { describe, it, expect } from "vitest";
import { varianceLineFromGap, outstandingGaps } from "./variance-line";

const GAP = {
  part_no: "TNA-16-04-40-2",
  description: "ACME STD ADAPTOR",
  qty: 5,
  unit_price: 1654.2,
  uom: "each",
  hsn: "8207",
  customer_part_number: "A44145ACME010004",
  source_quote_id: "q-1",
  source_quote_number: "Q-4471",
};

describe("varianceLineFromGap", () => {
  it("stamps the origin that drives every downstream guard", () => {
    const l = varianceLineFromGap(GAP)!;
    expect(l._origin).toBe("quote_variance");
    expect(l._added_at).toBeTruthy();
  });

  it("carries the agreed commercial terms across", () => {
    const l = varianceLineFromGap(GAP)!;
    expect(l.partNumber).toBe("TNA-16-04-40-2");
    expect(l.description).toBe("ACME STD ADAPTOR");
    expect(l.quantity).toBe(5);
    expect(l.unitPrice).toBe(1654.2);
    expect(l.uom).toBe("each");
    expect(l.hsn).toBe("8207");
    expect(l.customerItemCode).toBe("A44145ACME010004");
  });

  it("writes both spellings of qty and rate", () => {
    // Different consumers still read different aliases; a variance line must
    // not be the one that trips over that.
    const l = varianceLineFromGap(GAP)!;
    expect(l.qty).toBe(5);
    expect(l.rate).toBe(1654.2);
  });

  it("records which quote says the line is owed", () => {
    // An operator asked to justify this months later should not have to
    // reconstruct the provenance.
    const l = varianceLineFromGap(GAP)! as any;
    expect(l._variance_source).toEqual({ quote_id: "q-1", quote_number: "Q-4471" });
  });

  it("accepts a gap with a description but no part number", () => {
    const l = varianceLineFromGap({ description: "SOME PART", qty: 1 })!;
    expect(l.description).toBe("SOME PART");
    expect(l.partNumber).toBeNull();
  });

  it("refuses a gap with neither identity nor description", () => {
    // Seeding a blank row helps nobody.
    expect(varianceLineFromGap({ qty: 1, unit_price: 5 })).toBeNull();
    expect(varianceLineFromGap({})).toBeNull();
  });

  it.each([null, undefined])("returns null for %p", (v) => {
    expect(varianceLineFromGap(v)).toBeNull();
  });

  it("nulls empty strings rather than carrying them into matching", () => {
    const l = varianceLineFromGap({ part_no: "P-1", uom: "  ", hsn: "" })!;
    expect(l.uom).toBeNull();
    expect(l.hsn).toBeNull();
  });

  it("keeps a missing price null rather than defaulting to zero", () => {
    // Zero is a claim that the line is free. Absent is absent.
    const l = varianceLineFromGap({ part_no: "P-1", unit_price: null })!;
    expect(l.unitPrice).toBeNull();
  });
});

describe("outstandingGaps", () => {
  const gaps = [{ part_no: "P-1" }, { part_no: "P-2" }, { part_no: "P-3" }];

  it("offers every gap when the order has none of them", () => {
    expect(outstandingGaps(gaps, [{ partNumber: "OTHER" }])).toHaveLength(3);
  });

  it("stops offering a gap once a line for it exists", () => {
    // Otherwise a second click silently double-orders.
    const left = outstandingGaps(gaps, [{ partNumber: "P-2", _origin: "quote_variance" }]);
    expect(left.map((g) => g.part_no)).toEqual(["P-1", "P-3"]);
  });

  it("matches on the normalised key, as both reconciliation walks do", () => {
    expect(outstandingGaps([{ part_no: "P-1" }], [{ partNumber: "p 1" }])).toHaveLength(0);
  });

  it("also matches a line carrying the part under itemCode", () => {
    expect(outstandingGaps([{ part_no: "P-1" }], [{ itemCode: "P-1" }])).toHaveLength(0);
  });

  it("does not care HOW the line got there", () => {
    // If extraction later reports the part — the customer amended the PO —
    // the gap is resolved just as surely as if an operator added it.
    expect(outstandingGaps([{ part_no: "P-1" }], [{ partNumber: "P-1" }])).toHaveLength(0);
  });

  it("keeps offering a gap with no part number rather than hiding it", () => {
    const left = outstandingGaps([{ description: "no part no" }], [{ partNumber: "P-1" }]);
    expect(left).toHaveLength(1);
  });

  it.each([[null], [undefined], [[]]])("returns [] for gaps = %p", (g: any) => {
    expect(outstandingGaps(g, [{ partNumber: "P-1" }])).toEqual([]);
  });

  it("survives a null line array", () => {
    expect(outstandingGaps(gaps, null)).toHaveLength(3);
  });
});
