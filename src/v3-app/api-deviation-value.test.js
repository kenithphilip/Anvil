// What does a deviation between the PO and the quote actually cost?
//
// The reconciler has always reported a PERCENTAGE — "PO 1250 vs quote 1180
// (+5.93%)". Nobody approves a purchase order on a percentage, and the rupee
// figure was computed nowhere in the product. It needs no new data: po_rate,
// quote_rate and po_qty are all already derived per line. Until now the
// persisted FLAG dropped the quantity, so the one record an approver reads
// could not be priced.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deviationValue, currencyOf } from "../api/_lib/deviation-value.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// Real figures from the quotation that prompted this work.
const RECON = {
  flags: [
    { verdict: "price_mismatch", part_no: "BP8/35", po_rate: 1910, quote_rate: 1872, po_qty: 30, price_delta_pct: 2.03 },
    { verdict: "price_mismatch", part_no: "S8/M8-57AG", po_rate: 800, quote_rate: 823, po_qty: 30, price_delta_pct: -2.79 },
    { verdict: "unmatched", part_no: "X-9", po_rate: 500, po_qty: 4 },
    { verdict: "description_mismatch", part_no: "D-1" },
  ],
  quoted_not_ordered: [{ part_no: "Q-1", unit_price: 1000, qty: 2 }],
};

describe("the money", () => {
  it("prices a rate difference against the quantity actually ordered", () => {
    const d = deviationValue(RECON);
    // (1910-1872)*30 = +1140 ; (800-823)*30 = -690
    expect(d.priced.count).toBe(2);
    expect(d.net).toBe(450);
  });

  it("keeps the SIGN, because the two directions are different problems", () => {
    // Above quote: the customer will dispute the invoice.
    // Below quote: we are short and nobody noticed.
    const above = deviationValue({ flags: [{ verdict: "price_mismatch", po_rate: 110, quote_rate: 100, po_qty: 10 }] });
    const below = deviationValue({ flags: [{ verdict: "price_mismatch", po_rate: 90, quote_rate: 100, po_qty: 10 }] });
    expect(above.net).toBe(100);
    expect(below.net).toBe(-100);
  });

  it("does NOT net an unquoted line against a price difference", () => {
    // An unmatched line has no agreed price to differ FROM; its whole value is
    // exposure. Adding it to a delta would produce a number true of nothing.
    const d = deviationValue(RECON);
    expect(d.unmatched.amount).toBe(2000);
    expect(d.net).toBe(450);
    expect(d.at_stake).toBe(2450);
  });

  it("reports quoted-but-not-ordered separately and never nets it", () => {
    // Revenue not taken is not an overcharge.
    const d = deviationValue(RECON);
    expect(d.not_ordered.amount).toBe(2000);
    expect(d.net).toBe(450);
  });

  it("ignores a description mismatch, which carries no money", () => {
    const d = deviationValue({ flags: [{ verdict: "description_mismatch", part_no: "D-1" }] });
    expect(d.any).toBe(false);
    expect(d.net).toBe(0);
  });

  it("COUNTS what it could not price instead of silently dropping it", () => {
    // "₹0 at risk" and "6 of the 8 exceptions could not be priced" are very
    // different statements, and the second one must be sayable.
    const d = deviationValue({ flags: [{ verdict: "price_mismatch", part_no: "NOQTY", po_rate: 100, quote_rate: 90 }] });
    expect(d.priced.count).toBe(0);
    expect(d.unpriceable).toHaveLength(1);
    expect(d.unpriceable[0].missing).toBe("quantity");
  });

  it("orders lines worst-first by absolute exposure", () => {
    // The approver reads the top of the list; it must be the line that matters
    // most, not the first one parsed. -690 outranks +200.
    const d = deviationValue({ flags: [
      { verdict: "price_mismatch", part_no: "small", po_rate: 102, quote_rate: 100, po_qty: 100 },
      { verdict: "price_mismatch", part_no: "big", po_rate: 77, quote_rate: 100, po_qty: 30 },
    ] });
    expect(d.priced.lines[0].part_no).toBe("big");
  });

  it("survives an empty or malformed reconciliation", () => {
    for (const r of [null, {}, { flags: null }, { flags: [{}] }]) {
      expect(() => deviationValue(r)).not.toThrow();
      expect(deviationValue(r).net).toBe(0);
    }
  });
});

describe("currency, because this codebase has summed across it before", () => {
  const order = (lines, header) => ({ result: { salesOrder: { lineItems: lines, currency: header } } });

  it("refuses a single figure when the lines disagree", () => {
    const c = currencyOf(order([{ currency: "INR" }, { currency: "USD" }]));
    expect(c.comparable).toBe(false);
    expect(c.reason).toBe("mixed_line_currencies");
    expect(c.currency).toBeNull();
  });

  it("refuses when a line disagrees with the header", () => {
    expect(currencyOf(order([{ currency: "USD" }], "INR")).comparable).toBe(false);
  });

  it("accepts a single consistent currency", () => {
    expect(currencyOf(order([{ currency: "USD" }], "USD"))).toMatchObject({ currency: "USD", comparable: true });
  });

  it("falls back to INR when nothing states one", () => {
    expect(currencyOf(order([{}]))).toMatchObject({ currency: "INR", comparable: true });
  });
});

describe("the flag carries what pricing it requires", () => {
  const src = read("src/api/_lib/quote-reconcile.js");

  it("puts po_qty on the flag, or none of the above can be computed", () => {
    expect(src).toMatch(/po_qty: l\._match\.po_qty/);
    expect(src).toMatch(/quote_qty: l\._match\.quote_qty/);
  });
});

describe("the approver sees it", () => {
  const ws = read("src/v3-app/screens/so-workspace.tsx");

  it("computes the figure on the approve surface", () => {
    expect(ws).toMatch(/deviationValue\(recon, \{ currency: cur\.currency \}\)/);
  });

  it("says which DIRECTION the deviation runs", () => {
    expect(ws).toMatch(/"above" : "below"/);
  });

  it("shows nothing rather than a wrong total on mixed currency", () => {
    expect(ws).toMatch(/Lines disagree on currency/);
  });

  it("surfaces exceptions it could not price", () => {
    expect(ws).toMatch(/could not be priced/);
  });

  it("puts the amount beside the percentage on each flagged line", () => {
    // The same rate delta on 1 unit and on 3,000 reads identically as a %.
    expect(ws).toMatch(/f\.po_rate - f\.quote_rate\) \* f\.po_qty/);
  });
});
