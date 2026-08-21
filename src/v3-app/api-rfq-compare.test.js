// A supplier RFQ compared bids across currencies by comparing the raw numbers.
//
// supplier_rfq/matrix.js crowned the winner with
//   priced.reduce((a, b) => a.unit_price < b.unit_price ? a : b)
// across cells that each carry their own `currency` column — on the same row,
// unread. A ¥1,500 bid lost to a $20 bid on the digits alone, while being less
// than half the price. For an importer sourcing from JP, KR and CN that is the
// normal shape of an RFQ, not an edge case.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rankCells, toBase, currenciesNeeded, normCcy } from "../api/_lib/rfq-compare.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const CELLS = [
  { vendor_id: "jp", unit_price: 1500, currency: "JPY", lead_time_days: 45 },
  { vendor_id: "us", unit_price: 20, currency: "USD", lead_time_days: 20 },
];
const RATES = { JPY: 0.56, USD: 87 };

describe("the bug this replaces", () => {
  it("the raw comparison picked the WRONG vendor", () => {
    // Proving the old behaviour so the fix is not mistaken for a refactor.
    const rawMin = CELLS.reduce((a, b) => (a.unit_price < b.unit_price ? a : b));
    expect(rawMin.vendor_id).toBe("us");
    // ¥1500 x 0.56 = ₹840 ; $20 x 87 = ₹1740. The JPY bid is less than half.
    expect(rankCells(CELLS, { base: "INR", rates: RATES }).winner).toBe("jp");
  });
});

describe("conversion", () => {
  it("leaves the base currency alone", () => {
    expect(toBase(100, "INR", "INR", RATES)).toBe(100);
  });

  it("returns null rather than the raw number when no rate is known", () => {
    // Falling back to the unconverted value IS the original bug.
    expect(toBase(1500, "JPY", "INR", {})).toBeNull();
  });

  it("treats a missing currency as the base", () => {
    expect(toBase(100, null, "INR", RATES)).toBe(100);
  });

  it("normalises case and whitespace", () => {
    expect(normCcy(" jpy ")).toBe("JPY");
    expect(toBase(1500, " jpy ", "INR", RATES)).toBeCloseTo(840, 6);
  });
});

describe("refusing to crown a winner", () => {
  it("names NO winner when any priced cell cannot be converted", () => {
    // Ranking the convertible subset would answer "cheapest of the ones we
    // could price" while wearing the label "cheapest".
    const r = rankCells(CELLS, { base: "INR", rates: { USD: 87 } });
    expect(r.winner).toBeNull();
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe("missing_fx_rate");
    expect(r.missing_rates).toEqual(["JPY"]);
  });

  it("still returns every cell, so the operator sees the bids", () => {
    const r = rankCells(CELLS, { base: "INR", rates: {} });
    expect(r.cells).toHaveLength(2);
    expect(r.cells.every((c) => c.winner === false)).toBe(true);
  });

  it("says so when nothing was priced at all", () => {
    const r = rankCells([{ vendor_id: "a", unit_price: null }], { base: "INR", rates: {} });
    expect(r.reason).toBe("no_priced_quotes");
  });
});

describe("what it shows the operator", () => {
  it("exposes the converted value and the rate used, so the basis is visible", () => {
    const r = rankCells(CELLS, { base: "INR", rates: RATES });
    const jp = r.cells.find((c) => c.vendor_id === "jp");
    expect(jp.unit_price_base).toBeCloseTo(840, 4);
    expect(jp.fx_rate_used).toBe(0.56);
  });

  it("marks a tie rather than letting parse order decide it", () => {
    const r = rankCells([
      { vendor_id: "a", unit_price: 100, currency: "INR" },
      { vendor_id: "b", unit_price: 100, currency: "INR" },
    ], { base: "INR", rates: {} });
    expect(r.tied).toEqual(["a", "b"]);
  });

  it("flags when the cheapest bid is also the slowest", () => {
    // Reported, not acted on — ranking by price cannot see it, and whether
    // lead time should outrank price is a policy call, not a code one.
    expect(rankCells(CELLS, { base: "INR", rates: RATES }).slowest_is_cheapest).toBe(true);
  });

  it("does not claim that when lead times are unknown", () => {
    const r = rankCells(CELLS.map((c) => ({ ...c, lead_time_days: null })), { base: "INR", rates: RATES });
    expect(r.slowest_is_cheapest).toBe(false);
  });
});

describe("only the currencies actually quoted are looked up", () => {
  it("skips the base and de-duplicates", () => {
    expect(currenciesNeeded([{ currency: "INR" }, { currency: "usd" }, { currency: "USD" }, {}], "INR")).toEqual(["USD"]);
  });
});

describe("the endpoint", () => {
  const src = read("src/api/supplier_rfq/matrix.js");

  it("no longer reduces on the raw unit_price", () => {
    expect(src).not.toMatch(/a\.unit_price < b\.unit_price/);
    expect(src).toMatch(/rankCells\(cells, \{ base, rates: fxRates \}\)/);
  });

  it("looks the rates up once, not per line", () => {
    expect((src.match(/from\("fx_rates"\)/g) || []).length).toBe(1);
    expect(src).toMatch(/currenciesNeeded\(quotes, base\)/);
  });

  it("takes the most recent rate at or before today", () => {
    expect(src).toMatch(/order\("as_of", \{ ascending: false \}\)/);
    expect(src).toMatch(/\.lte\("as_of"/);
  });

  it("survives an FX read failure without losing the whole matrix", () => {
    // Losing every bid because a rate table hiccuped is worse than losing a
    // winner badge.
    expect(src).toMatch(/!fxQ\.error && fxQ\.data/);
  });

  it("tells the caller what the comparison was done in", () => {
    expect(src).toMatch(/comparison_base: base/);
    expect(src).toMatch(/not_comparable_reason/);
  });
});
