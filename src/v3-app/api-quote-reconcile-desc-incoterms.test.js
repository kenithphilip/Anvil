// Two discrepancy types the reconciler collected and never reported.
//
// DESCRIPTION: descAgreement() was computed for every matched line and stored
// on _match.desc_agreement — and nothing ever read it. A PO line whose
// description had completely changed from the quote reconciled as a clean
// match, which is exactly the qualitative discrepancy the operator needs.
//
// INCOTERMS: never compared at all. A PO switching FOB to CIF moves who pays
// the freight and who carries the risk, and passed reconciliation silently.

import { describe, it, expect } from "vitest";
import {
  reconcilePoAgainstQuotes, compareIncoterms, parseIncoterm,
} from "../api/_lib/quote-reconcile.js";

const q = (over = {}) => ({
  part_no: "TNA-16-04", description: "CYLINDER ASSY", qty: 10,
  discounted_unit_price: 100, _quote_id: "q1", _quote_number: "Q-001", ...over,
});
const po = (over = {}) => ({
  part_no: "TNA-16-04", description: "CYLINDER ASSY", qty: 10, rate: 100, ...over,
});

describe("description discrepancy", () => {
  it("matches when the wording merely differs in detail", () => {
    // Forgiving on purpose: the same part is routinely written differently on
    // a quote and a PO. Flagging these would make the signal useless.
    const r = reconcilePoAgainstQuotes(
      [po({ description: "Cylinder Assembly, 40mm bore" })],
      [q({ description: "CYLINDER ASSY" })],
    );
    expect(r.lines[0]._match.verdict).toBe("matched");
    expect(r.summary.description_mismatch).toBe(0);
  });

  // The regression.
  it("flags a description that has genuinely diverged", () => {
    const r = reconcilePoAgainstQuotes(
      [po({ description: "HYDRAULIC PUMP HOUSING" })],
      [q({ description: "CYLINDER ASSY" })],
    );
    expect(r.lines[0]._match.verdict).toBe("description_mismatch");
    expect(r.summary.description_mismatch).toBe(1);
    expect(r.summary.matched).toBe(0);
  });

  it("carries both descriptions into the flag the UI renders", () => {
    const r = reconcilePoAgainstQuotes(
      [po({ description: "HYDRAULIC PUMP HOUSING" })],
      [q({ description: "CYLINDER ASSY" })],
    );
    const f = r.flags.find((x) => x.verdict === "description_mismatch");
    expect(f.po_description).toBe("HYDRAULIC PUMP HOUSING");
    expect(f.quote_description).toBe("CYLINDER ASSY");
    expect(f.desc_agreement).toBeLessThan(0.34);
  });

  it("lets a price mismatch win when both differ", () => {
    // A wrong price is the more urgent fact; the description delta still
    // travels on _match so the UI can show both.
    const r = reconcilePoAgainstQuotes(
      [po({ description: "HYDRAULIC PUMP HOUSING", rate: 250 })],
      [q({ description: "CYLINDER ASSY" })],
    );
    expect(r.lines[0]._match.verdict).toBe("price_mismatch");
    expect(r.lines[0]._match.desc_mismatch).toBe(true);
  });

  it("does not flag when either side has no description", () => {
    // No description is missing data, not a discrepancy.
    for (const pair of [[{ description: null }, {}], [{}, { description: "" }]]) {
      const r = reconcilePoAgainstQuotes([po(pair[0])], [q(pair[1])]);
      expect(r.lines[0]._match.verdict).toBe("matched");
    }
  });
});

describe("parseIncoterm", () => {
  it("pulls the rule and the named place apart", () => {
    expect(parseIncoterm("FOB Busan")).toEqual({ code: "FOB", place: "Busan" });
    expect(parseIncoterm("CIF Nhava Sheva")).toEqual({ code: "CIF", place: "Nhava Sheva" });
  });

  it("finds a code with no place", () => {
    expect(parseIncoterm("EXW")).toEqual({ code: "EXW", place: null });
  });

  it("keeps unparseable text as a place rather than discarding it", () => {
    expect(parseIncoterm("to be agreed")).toEqual({ code: null, place: "to be agreed" });
  });

  it.each([null, undefined, "", "   "])("is empty for %p", (v) => {
    expect(parseIncoterm(v)).toEqual({ code: null, place: null });
  });
});

describe("compareIncoterms", () => {
  it("matches identical rules", () => {
    expect(compareIncoterms("FOB Busan", "FOB Busan").verdict).toBe("match");
  });

  // The one with commercial consequence: who pays freight and carries risk.
  it("flags a changed rule", () => {
    const r = compareIncoterms("CIF Nhava Sheva", "FOB Busan");
    expect(r.verdict).toBe("mismatch");
    expect(r.po_code).toBe("CIF");
    expect(r.quote_code).toBe("FOB");
  });

  it("distinguishes a changed PLACE from a changed rule", () => {
    // Same rule, different port still moves who pays for which leg — worth
    // reporting, but not the same thing as CIF becoming FOB.
    const r = compareIncoterms("FOB Busan", "FOB Incheon");
    expect(r.verdict).toBe("place_differs");
    expect(r.po_code).toBe("FOB");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(compareIncoterms("fob, busan", "FOB Busan").verdict).toBe("match");
  });

  it("reads the rule out of a longer terms string", () => {
    // quotes has no incoterm column, so the quote side is parsed from free text.
    const r = compareIncoterms("FOB Busan", "FOB Busan, 30 days net");
    expect(r.quote_code).toBe("FOB");
  });

  it("is unknown when either side is absent, not a mismatch", () => {
    expect(compareIncoterms(null, "FOB Busan").verdict).toBe("unknown");
    expect(compareIncoterms("FOB Busan", "").verdict).toBe("unknown");
  });

  it("still compares free text when neither parses", () => {
    expect(compareIncoterms("to be agreed", "to be agreed").verdict).toBe("match");
    expect(compareIncoterms("to be agreed", "ex works our plant").verdict).toBe("mismatch");
  });
});
