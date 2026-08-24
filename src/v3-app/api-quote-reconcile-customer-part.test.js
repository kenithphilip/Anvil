// A PO that prints only the buyer's code matched nothing at all.
//
// The reconciler indexed quote lines on OUR part number and matched PO lines
// on the same, while `customer_part_number` — present on both sides — was
// carried through to the output and never compared. So a purchase order
// carrying only the customer's reference produced a clean-looking
// reconciliation in which every line was "ordered but never quoted".
//
// That is the normal shape of a customer PO, not an edge case. On a real one
// the item code is the BUYER's; our own part number appears nowhere on the
// document and only shows up on the sales order after a person has looked it
// up in the dual-code map.

import { describe, it, expect } from "vitest";
import { reconcilePoAgainstQuotes } from "../api/_lib/quote-reconcile.js";

const qline = (over = {}) => ({
  _quote_id: "q1", _quote_number: "Q-1", _quote_created_at: "2026-01-01T00:00:00Z",
  part_no: "OUR-1", customer_part_number: "THEIRS-1", description: "Bend adapter",
  qty: 1, discounted_unit_price: 100, ...over,
});

describe("matching on the buyer's code", () => {
  it("matches a PO line that carries ONLY the customer's reference", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100, description: "Bend adapter" }],
      [qline()],
    );
    expect(r.summary.unmatched).toBe(0);
    expect(r.summary.matched).toBe(1);
    expect(r.lines[0]._match.matched_on).toBe("customer_part_number");
  });

  it("still prefers our own part number when the PO carries both", () => {
    // Tiered, not either/or: a PO naming both should reconcile against the
    // part we actually sell.
    const r = reconcilePoAgainstQuotes(
      [{ part_no: "OUR-1", customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline()],
    );
    expect(r.lines[0]._match.matched_on).toBe("part_no");
  });

  it("does not let the buyer's code override a part_no match", () => {
    // Two quote lines: one matching our code, one whose CUSTOMER code collides
    // with the PO's. The part_no hit must win.
    const r = reconcilePoAgainstQuotes(
      [{ part_no: "OUR-1", customer_part_number: "THEIRS-2", qty: 1, rate: 100 }],
      [qline(), qline({ part_no: "OUR-2", customer_part_number: "THEIRS-2", discounted_unit_price: 999 })],
    );
    expect(r.lines[0]._match.matched_on).toBe("part_no");
    expect(r.lines[0]._match.quote_rate).toBe(100);
  });

  it("reads the buyer's code from whichever slot the extractor used", () => {
    for (const field of ["customer_part_number", "customerItemCode", "customer_item_code"]) {
      const r = reconcilePoAgainstQuotes([{ [field]: "THEIRS-1", qty: 1, rate: 100 }], [qline()]);
      expect(r.summary.matched, field).toBe(1);
    }
  });

  it("is case- and space-insensitive, like the part_no path", () => {
    const r = reconcilePoAgainstQuotes([{ customer_part_number: " theirs-1 ", qty: 1, rate: 100 }], [qline()]);
    expect(r.summary.matched).toBe(1);
  });
});

describe("what unmatched now tells you", () => {
  it("names the identifiers it tried", () => {
    // "Unmatched" on a line that only ever carried the buyer's code means
    // something different from unmatched on one carrying ours.
    const r = reconcilePoAgainstQuotes(
      [{ part_no: "NOPE", customer_part_number: "ALSO-NOPE", qty: 1, rate: 1 }],
      [qline()],
    );
    expect(r.lines[0]._match.verdict).toBe("unmatched");
    // AS PRINTED, not as keyed: normPart strips every non-alphanumeric, so the
    // key for "ALSO-NOPE" is "ALSONOPE" — a string on no document, which
    // nobody can search for.
    expect(r.lines[0]._match.tried).toEqual({ part_no: "NOPE", customer_part_number: "ALSO-NOPE" });
  });
});

describe("ambiguity is per index", () => {
  it("flags a buyer code that appears in two different quotes", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline(), qline({ _quote_id: "q2", _quote_number: "Q-2", part_no: "OUR-9" })],
    );
    expect(r.lines[0]._match.ambiguous).toBe(true);
  });

  it("does not report a part_no conflict on a customer-code match", () => {
    // Checking the wrong set would report a conflict that is not there — or
    // miss the one that is.
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline()],
    );
    expect(r.lines[0]._match.ambiguous).toBe(false);
  });
});

describe("the reverse walk stays honest", () => {
  it("does NOT report a customer-code match as quoted-but-never-ordered", () => {
    // The bug this nearly introduced. orderedKeys is what the reverse walk
    // subtracts, and it recorded the PO LINE's key — which for a customer-code
    // match is empty or different from the quote's part_no. The quote's part
    // would stay unsubtracted and be reported as a gap, having been ordered,
    // matched and priced.
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline()],
    );
    expect(r.summary.matched).toBe(1);
    expect(r.quoted_not_ordered || []).toHaveLength(0);
  });

  it("still reports a genuinely un-ordered quote line", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline(), qline({ part_no: "OUR-2", customer_part_number: "THEIRS-2" })],
    );
    expect((r.quoted_not_ordered || []).map((x) => x.part_no)).toEqual(["OUR-2"]);
  });
});
