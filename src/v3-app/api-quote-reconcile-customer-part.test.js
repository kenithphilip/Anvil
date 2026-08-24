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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcilePoAgainstQuotes } from "../api/_lib/quote-reconcile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

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

// ── Third tier: the canonical dual-code map ──────────────────────────
//
// The two tiers above can only match a buyer code that some QUOTE LINE happens
// to carry. item_customer_parts is the canonical mapping — grown by the ingest
// every time an operator confirms a part — so it knows codes no quote ever
// recorded. Without it a PO naming a part we have sold this customer for years
// still came back unmatched, purely because the code was absent from the quote
// rows.

describe("matching through item_customer_parts", () => {
  const map = new Map([["THEIRS-9", "OUR-1"]]);

  it("matches a buyer code that appears on NO quote line", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline({ customer_part_number: null })],          // the quote knows nothing of THEIRS-9
      { customerPartMap: map },
    );
    expect(r.summary.matched).toBe(1);
    expect(r.lines[0]._match.matched_on).toBe("item_customer_parts");
  });

  it("is the LAST resort — a quote-line code still wins", () => {
    // Tier 2 is a direct observation on the document we are reconciling
    // against; the map is a stored belief about the customer.
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-1", qty: 1, rate: 100 }],
      [qline()],
      { customerPartMap: new Map([["THEIRS-1", "OUR-OTHER"]]) },
    );
    expect(r.lines[0]._match.matched_on).toBe("customer_part_number");
  });

  it("never displaces a part_no match", () => {
    const r = reconcilePoAgainstQuotes(
      [{ part_no: "OUR-1", customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline()],
      { customerPartMap: map },
    );
    expect(r.lines[0]._match.matched_on).toBe("part_no");
  });

  it("normalises the map's keys, so the caller need not know our key rules", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "theirs 9", qty: 1, rate: 100 }],
      [qline({ customer_part_number: null })],
      { customerPartMap: new Map([[" Theirs-9 ", "OUR-1"]]) },
    );
    expect(r.summary.matched).toBe(1);
  });

  it("stays unmatched when the map points at a part no quote carries", () => {
    // A mapping is not a quotation. Resolving to a part nobody priced must not
    // manufacture a match.
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline({ part_no: "SOMETHING-ELSE", customer_part_number: null })],
      { customerPartMap: map },
    );
    expect(r.lines[0]._match.verdict).toBe("unmatched");
  });

  it("behaves exactly as before when no map is supplied", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline({ customer_part_number: null })],
    );
    expect(r.lines[0]._match.verdict).toBe("unmatched");
  });

  it("ignores a non-Map option rather than throwing", () => {
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline({ customer_part_number: null })],
      { customerPartMap: { "THEIRS-9": "OUR-1" } },     // a plain object
    );
    expect(r.lines[0]._match.verdict).toBe("unmatched");
  });

  it("subtracts the matched quote from the reverse walk", () => {
    // Same trap as tier 2: orderedKeys must record the QUOTE's part_no, or the
    // part gets reported as quoted-but-never-ordered having just been matched.
    const r = reconcilePoAgainstQuotes(
      [{ customer_part_number: "THEIRS-9", qty: 1, rate: 100 }],
      [qline({ customer_part_number: null })],
      { customerPartMap: map },
    );
    expect(r.quoted_not_ordered || []).toHaveLength(0);
  });
});

describe("the route builds the map safely", () => {
  const src = read("src/api/orders/reconcile_quotes.js");

  it("filters to the ACTIVE mapping", () => {
    // Migration 129 enforces one active row per (tenant, customer, code);
    // superseded rows keep a stamped valid_to. Omitting the filter resolves a
    // buyer code to a part it USED to mean.
    expect(src).toMatch(/\.is\("valid_to", null\)/);
  });

  it("scopes to the order's customer", () => {
    expect(src).toMatch(/\.eq\("customer_id", order\.customer_id\)/);
  });

  it("chunks the item_master lookup", () => {
    expect(src).toMatch(/i \+= 100/);
  });

  it("is best-effort — a map failure must not lose the reconciliation", () => {
    // The map only ever ADDS matches; two tiers of reconciliation beat none.
    expect(src).toMatch(/catch \(_e\) \{[\s\S]{0,200}Best-effort/);
  });
});
