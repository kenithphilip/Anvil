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
    const r = reconcilePoAgainstQuotes([], [qline("P-9", { qty: 5 })]);
    const g = r.quoted_not_ordered[0];
    expect(g).toMatchObject({
      part_no: "P-9", qty: 5, uom: "nos", hsn: "8207",
      source_quote_number: "Q-4471",
    });
    expect(g.unit_price).toBe(90);        // the DISCOUNTED price, what was agreed
    expect(g.description).toBeTruthy();
  });

  it("falls back to the listed price when nothing was discounted", () => {
    const r = reconcilePoAgainstQuotes([], [qline("P-9", { discounted_unit_price: null })]);
    expect(r.quoted_not_ordered[0].unit_price).toBe(100);
  });

  it("reports a part once however many quote revisions carry it", () => {
    // Three revisions of the same part is ONE thing missing from the PO.
    const r = reconcilePoAgainstQuotes([], [
      qline("P-2", { _quote_number: "Q-1" }),
      qline("P-2", { _quote_number: "Q-2" }),
      qline("P-2", { _quote_number: "Q-3" }),
    ]);
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
