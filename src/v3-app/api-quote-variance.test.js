// Quoted but not ordered (P3).
//
// reconcilePoAgainstQuotes walked the PO and asked "was this quoted?". Nothing
// asked the reverse — "was anything quoted that the PO does not contain?" — so
// a customer PO short against the agreed quote reconciled clean, with no
// signal at all. The operator had to notice unaided.
//
// The second half is the gate. A line an operator adds because the QUOTE owes
// it is not a line the customer ordered, so pushing it to Tally would create a
// voucher for goods the buyer never authorised on their PO.

import { describe, it, expect } from "vitest";
import { reconcilePoAgainstQuotes } from "../api/_lib/quote-reconcile.js";

const qline = (part, extra = {}) => ({
  quote_id: "q1", _quote_id: "q1", _quote_number: "Q-4471", _quote_created_at: "2026-08-01",
  part_no: part, description: part + " widget", qty: 2, uom: "nos",
  listed_unit_price: 100, discounted_unit_price: 90, hsn_sac: "8207",
  ...extra,
});
const oline = (part, extra = {}) => ({ partNumber: part, quantity: 2, unitPrice: 90, ...extra });

// A PO that matched at least ONE line of the quote, so the quote counts as the
// one this PO was placed against. Gaps are now scoped to quotes the PO actually
// drew from — a quote it matched nothing from is not evidence of a short order,
// it is an unrelated quote (a 2-line PO was reporting 411 gaps off a
// never-sent spare-matrix draft). These fixtures used an EMPTY PO purely as a
// shortcut; the anchor keeps what they actually test.
const ANCHOR = qline("ANCHOR");
const anchored = (...lines) => [ANCHOR, ...lines];

describe("the reverse walk", () => {
  it("reports a quoted part the PO never ordered", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1")], [qline("P-1"), qline("P-2")]);
    expect(r.quoted_not_ordered).toHaveLength(1);
    expect(r.quoted_not_ordered[0].part_no).toBe("P-2");
    expect(r.summary.quoted_not_ordered).toBe(1);
  });

  it("says nothing when the PO ordered everything quoted", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1"), oline("P-2")], [qline("P-1"), qline("P-2")]);
    expect(r.quoted_not_ordered).toHaveLength(0);
    expect(r.summary.quoted_not_ordered).toBe(0);
  });

  it("carries enough to rebuild the line — this is what the operator would add", () => {
    const r = reconcilePoAgainstQuotes([oline("ANCHOR")], anchored(qline("P-9", { qty: 5 })));
    const g = r.quoted_not_ordered[0];
    expect(g).toMatchObject({
      part_no: "P-9", qty: 5, uom: "nos", hsn: "8207",
      source_quote_number: "Q-4471",
    });
    expect(g.unit_price).toBe(90);        // the DISCOUNTED price, what was agreed
    expect(g.description).toBeTruthy();
  });

  it("falls back to the listed price when nothing was discounted", () => {
    const r = reconcilePoAgainstQuotes([oline("ANCHOR")], anchored(qline("P-9", { discounted_unit_price: null })));
    expect(r.quoted_not_ordered[0].unit_price).toBe(100);
  });

  it("reports a part once however many quote revisions carry it", () => {
    // Three revisions of the same part is ONE thing missing from the PO.
    // All three revisions share _quote_id "q1", so one anchored match makes
    // the whole set eligible.
    const r = reconcilePoAgainstQuotes([oline("ANCHOR")], anchored(
      qline("P-2", { _quote_number: "Q-1" }),
      qline("P-2", { _quote_number: "Q-2" }),
      qline("P-2", { _quote_number: "Q-3" }),
    ));
    expect(r.quoted_not_ordered).toHaveLength(1);
  });

  it("matches on the same normalised key the forward walk uses", () => {
    // If the two directions normalised differently, a matched line would also
    // show up as missing — the worst possible false positive here.
    const r = reconcilePoAgainstQuotes([oline("p 1")], [qline("P-1")]);
    expect(r.quoted_not_ordered).toHaveLength(0);
  });

  it("ignores quote lines with no part number rather than reporting a blank", () => {
    const r = reconcilePoAgainstQuotes([], [qline(null), qline("")]);
    expect(r.quoted_not_ordered).toHaveLength(0);
  });

  it("is empty, not undefined, when there are no quotes at all", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1")], []);
    expect(r.quoted_not_ordered).toEqual([]);
  });

  // A gap is NOT an exception: a customer ordering part of a quote is ordinary.
  it("does not add a flag — only a human can call this an omission", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1")], [qline("P-1"), qline("P-2")]);
    expect(r.flags.some((f) => /not_ordered/.test(f.verdict || ""))).toBe(false);
  });

  it("leaves the forward walk's verdicts untouched", () => {
    const r = reconcilePoAgainstQuotes(
      [oline("P-1", { unitPrice: 200 })],
      [qline("P-1"), qline("P-2")],
    );
    expect(r.lines[0]._match.verdict).toBe("price_mismatch");
    expect(r.summary.price_mismatch).toBe(1);
    expect(r.quoted_not_ordered).toHaveLength(1);
  });
});

// A 2-line customer PO was reporting 411 quoted-but-not-ordered rows, every one
// offering a one-click "Add as variance" — because the walk iterated the whole
// customer quote pool and subtracted only the keys that matched. With nothing
// matched, nothing was subtracted, so every part of every quote the customer had
// ever received became a "gap".
describe("gaps are scoped to the quote the PO was placed against", () => {
  const other = (part) => ({
    quote_id: "q2", _quote_id: "q2", _quote_number: "Q-OTHER", _quote_created_at: "2026-07-01",
    part_no: part, description: part, qty: 1, listed_unit_price: 0,
  });

  it("reports nothing from a quote the PO matched no line of", () => {
    const r = reconcilePoAgainstQuotes(
      [oline("P-1")],
      [qline("P-1"), other("CAT-1"), other("CAT-2"), other("CAT-3")],
    );
    // P-1 matched q1; q2 is an unrelated quote and contributes no gaps.
    expect(r.quoted_not_ordered).toHaveLength(0);
  });

  it("reports nothing at all when the PO matched nothing", () => {
    // The observed case: 0/2 matched, 411 gaps. No match means no evidence the
    // PO and the quote are related.
    const r = reconcilePoAgainstQuotes([oline("UNKNOWN")], [other("CAT-1"), other("CAT-2")]);
    expect(r.quoted_not_ordered).toHaveLength(0);
    expect(r.summary.unmatched).toBe(1);
  });

  it("still reports a genuine short order against the matched quote", () => {
    // The case the feature exists for must survive the scoping.
    const r = reconcilePoAgainstQuotes([oline("P-1")], [qline("P-1"), qline("P-2"), qline("P-3")]);
    expect(r.quoted_not_ordered.map((g) => g.part_no).sort()).toEqual(["P-2", "P-3"]);
  });
});

// An unpriced draft line is not a price. spare_matrix/to_quote.js writes
// listed_unit_price: 0 by design ("priced downstream in price_composition").
describe("a zero quoted rate does not overwrite the PO's price", () => {
  const unpriced = (part) => qline(part, { listed_unit_price: 0, discounted_unit_price: null });

  it("keeps the PO's rate on the enriched line", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1", { unitPrice: 250 })], [unpriced("P-1")]);
    expect(r.lines[0].discounted_unit_price).toBe(250);
  });

  it("does not report a price mismatch against a non-price", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1", { unitPrice: 250 })], [unpriced("P-1")]);
    expect(r.lines[0]._match.verdict).toBe("matched");
    expect(r.lines[0]._match.price_delta_pct).toBeNull();
  });

  it("still compares a real quoted price", () => {
    const r = reconcilePoAgainstQuotes([oline("P-1", { unitPrice: 250 })], [qline("P-1")]);
    expect(r.lines[0]._match.verdict).toBe("price_mismatch");
    expect(r.lines[0].discounted_unit_price).toBe(90);
  });
});
