// Comparing Anvil against a clerk measures agreement, not correctness.
//
// The purchase order is the authority on what the customer ordered. A two-way
// harness rewards Anvil for reproducing a clerk's mistakes and marks it wrong
// for catching them — the opposite of the thing being bought.
//
// The case that justifies the whole design is BOTH_DEVIATE, and it is drawn
// from a real pair: the PO stated payment after 60 days, the Tally SO said 30.
// If Anvil had also said 30 — defaulting to the customer master's usual terms
// instead of reading the document — a two-way comparison would score that
// field agreed, perfect, while the business had committed to terms worth 30
// days of working capital that its customer never asked for.

import { describe, it, expect } from "vitest";
import { VERDICT, adjudicateField, scoreAdjudications, isDecidable } from "../api/_lib/three-way-adjudicate.js";

const judge = (truth, anvil, tally, spec) => adjudicateField({ truth, anvil, tally }, spec).verdict;

describe("the five decidable outcomes", () => {
  it("all three agree", () => {
    expect(judge("A", "A", "A")).toBe(VERDICT.AGREE);
  });

  it("Anvil matches the PO and the clerk does not", () => {
    // This must NOT count against Anvil. It is the finding the product exists
    // to produce.
    expect(judge("60 days", "60 days", "30 days")).toBe(VERDICT.ANVIL_CORRECT);
  });

  it("the clerk matches the PO and Anvil does not", () => {
    // The only outcome that is straightforwardly an Anvil defect.
    expect(judge("60 days", "30 days", "60 days")).toBe(VERDICT.ANVIL_WRONG);
  });

  it("Anvil and the clerk agree with each other, and both are wrong", () => {
    // THE case. A two-way test scores this 100%.
    expect(judge("60 days", "30 days", "30 days")).toBe(VERDICT.BOTH_DEVIATE);
  });

  it("three different answers", () => {
    expect(judge("60 days", "45 days", "30 days")).toBe(VERDICT.ALL_DIFFER);
  });
});

describe("what must never be scored", () => {
  it("a field the authority is silent on", () => {
    // Resolving ambiguity in somebody's favour is worse than admitting the gap.
    expect(judge(null, "A", "B")).toBe(VERDICT.UNDECIDABLE);
    expect(judge("", "A", "B")).toBe(VERDICT.UNDECIDABLE);
    expect(judge("   ", "A", "B")).toBe(VERDICT.UNDECIDABLE);
  });

  it("a field nothing outside Tally could know", () => {
    // The voucher number is Tally's own sequence. Not a pass, not a fail.
    expect(judge("x", "y", "2692", { authority: "none" })).toBe(VERDICT.NOT_APPLICABLE);
  });

  it("a value the normaliser could not read", () => {
    const boom = () => { throw new Error("unparseable"); };
    const r = adjudicateField({ truth: "6-8 weeks", anvil: "x", tally: "y" }, { normalise: boom });
    expect(r.verdict).toBe(VERDICT.UNDECIDABLE);
    expect(r.reason).toBe("normalise_failed");
  });

  it("neither undecidable nor not-applicable is decidable", () => {
    expect(isDecidable(VERDICT.UNDECIDABLE)).toBe(false);
    expect(isDecidable(VERDICT.NOT_APPLICABLE)).toBe(false);
    expect(isDecidable(VERDICT.BOTH_DEVIATE)).toBe(true);
  });
});

describe("the authority is per field, not global", () => {
  it("our own part number is judged by the item master, not the PO", () => {
    // The PO carries the BUYER's code and never says what ours is. Judging it
    // against the PO would make it permanently undecidable; judging it against
    // item_master makes it the most valuable field in the comparison.
    const r = adjudicateField(
      { truth: "3-380153-2-I", anvil: "3-380153-2-I", tally: "3-380153-2-X" },
      { key: "our_part_no", authority: "item_master" },
    );
    expect(r.verdict).toBe(VERDICT.ANVIL_CORRECT);
    expect(r.authority).toBe("item_master");
  });
});

describe("comparison respects the field's type", () => {
  it("numbers compare with a tolerance, not as strings", () => {
    expect(judge(9496.30, "9496.3", 9496.30, { compare: "number" })).toBe(VERDICT.AGREE);
  });

  it("a real price difference is not swallowed by the tolerance", () => {
    expect(judge(9790, 9790, 9490, { compare: "number" })).toBe(VERDICT.ANVIL_CORRECT);
  });

  it("text compares case- and space-insensitively", () => {
    expect(judge("THB-L1-70B-2", " thb-l1-70b-2 ", "THB-L1-70B-2")).toBe(VERDICT.AGREE);
  });

  it("a normaliser folds prose into one canonical value", () => {
    // "Net 60" and "60 days after receipt of goods" are one term, not two.
    const days = (v) => String(v).match(/\d+/)?.[0] ?? "";
    expect(judge("AFTER 60 DAYS ON RECEIPT OF GOODS", "Net 60", "30 Days", { normalise: days }))
      .toBe(VERDICT.ANVIL_CORRECT);
  });
});

describe("absence is a value", () => {
  it("Anvil omitting a field the PO states is not correct", () => {
    expect(judge("60 days", null, "60 days")).toBe(VERDICT.ANVIL_WRONG);
  });

  it("both omitting it is both deviating, not agreement", () => {
    expect(judge("60 days", null, null)).toBe(VERDICT.BOTH_DEVIATE);
  });
});

describe("two rates, because one cannot carry this", () => {
  const rows = [
    { verdict: VERDICT.AGREE }, { verdict: VERDICT.AGREE }, { verdict: VERDICT.AGREE },
    { verdict: VERDICT.ANVIL_CORRECT },      // the clerk erred
    { verdict: VERDICT.ANVIL_WRONG },        // Anvil erred
    { verdict: VERDICT.BOTH_DEVIATE },       // both erred
    { verdict: VERDICT.UNDECIDABLE },        // excluded
    { verdict: VERDICT.NOT_APPLICABLE },     // excluded
  ];

  it("excludes undecidable and not-applicable from the denominator", () => {
    expect(scoreAdjudications(rows).decidable).toBe(6);
  });

  it("counts both_deviate against Anvil — agreeing with the clerk is no excuse", () => {
    // anvil_wrong + both_deviate + all_differ = 2 of 6
    expect(scoreAdjudications(rows).anvil_error_rate).toBeCloseTo(2 / 6, 4);
  });

  it("reports the manual process's own deviation rate separately", () => {
    // anvil_correct + both_deviate + all_differ = 2 of 6. Reporting only
    // Anvil's rate would bury the finding that sells the product.
    expect(scoreAdjudications(rows).process_deviation_rate).toBeCloseTo(2 / 6, 4);
  });

  it("returns null, not zero, when nothing was decidable", () => {
    // A rate over an empty denominator reads as a perfect score.
    const none = scoreAdjudications([{ verdict: VERDICT.UNDECIDABLE }]);
    expect(none.anvil_error_rate).toBeNull();
    expect(none.basis).toBe("no_decidable_fields");
  });

  it("survives empty and malformed input", () => {
    expect(scoreAdjudications([]).decidable).toBe(0);
    expect(scoreAdjudications(null).decidable).toBe(0);
    expect(scoreAdjudications([{}, { verdict: "nonsense" }]).decidable).toBe(0);
  });
});

describe("the worked example from the real pair", () => {
  // PO: payment after 60 days on receipt of goods; delivery within 6-8 weeks.
  // Tally SO: 30 days; due ~4 weeks out. Anvil read the document correctly.
  const days = (v) => String(v).match(/\d+/)?.[0] ?? "";
  const rows = [
    adjudicateField({ truth: "1.000", anvil: "1", tally: "1" }, { key: "qty", compare: "number" }),
    adjudicateField({ truth: 9790.0, anvil: 9790.0, tally: 9790.0 }, { key: "rate", compare: "number" }),
    adjudicateField({ truth: 3, anvil: 3, tally: 3 }, { key: "disc_pct", compare: "number" }),
    adjudicateField({ truth: "AFTER 60 DAYS ON RECEIPT OF GOODS", anvil: "60 days", tally: "30 Days" },
      { key: "payment_terms", normalise: days }),
    adjudicateField({ truth: null, anvil: "2692", tally: "2692" }, { key: "voucher_no", authority: "none" }),
  ];

  it("finds the payment-term deviation and blames the process, not Anvil", () => {
    const terms = rows.find((r) => r.key === "payment_terms");
    expect(terms.verdict).toBe(VERDICT.ANVIL_CORRECT);
  });

  it("scores Anvil clean while reporting the process deviated", () => {
    const s = scoreAdjudications(rows);
    expect(s.anvil_error_rate).toBe(0);
    expect(s.process_deviation_rate).toBeGreaterThan(0);
  });

  it("does not let the voucher number touch either rate", () => {
    expect(scoreAdjudications(rows).decidable).toBe(4);
  });
});
