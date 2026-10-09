// The clause taxonomy and the default terms policy are data.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 3.1 lists the 13 clauses and
// their structured values; section 5.2 sets the default severity of each
// outcome; section 5.3 ships that table as DEFAULT_TERMS_POLICY, which a
// tenant overrides key by key. These tests pin the data to the design.

import { describe, it, expect } from "vitest";
import {
  CLAUSE_KEYS, CLAUSE_TAXONOMY, DEFAULT_TERMS_POLICY, SEVERITY_LEVELS, OUTCOMES,
  PAYMENT_BASES, PAYMENT_INSTRUMENTS, ONE_SIDED_SUBTYPES, valueFitsShape,
} from "../api/_lib/terms/taxonomy.js";

describe("the clause taxonomy (section 3.1)", () => {
  it("has the 13 clause keys, in the table's order", () => {
    expect(CLAUSE_KEYS).toEqual([
      "incoterm", "payment_terms", "delivery_lead_time", "price_basis", "freight_insurance",
      "taxes", "validity", "warranty", "ld_penalty", "inspection_acceptance", "cancellation",
      "jurisdiction", "one_sided",
    ]);
  });

  it.each([
    ["incoterm", ["code", "place"]],
    ["payment_terms", ["days", "basis", "advance_pct", "instrument"]],
    ["delivery_lead_time", ["min_days", "max_days", "from", "fixed_date"]],
    ["price_basis", ["basis", "place"]],
    ["freight_insurance", ["freight", "insurance", "packing"]],
    ["taxes", ["gst", "rate_pct"]],
    ["validity", ["days", "expires_at"]],
    ["warranty", ["months", "from", "scope"]],
    ["ld_penalty", ["rate_pct", "per", "cap_pct", "excluded"]],
    ["inspection_acceptance", ["stage", "by", "rejection_rights", "deemed_acceptance_days"]],
    ["cancellation", ["buyer_may_cancel", "notice_days", "compensation"]],
    ["jurisdiction", ["courts_place", "governing_law", "arbitration"]],
    ["one_sided", ["subtype"]],
  ])("%s has the value fields %j", (clause, fields) => {
    expect(Object.keys(CLAUSE_TAXONOMY[clause].value)).toEqual(fields);
  });

  it("names the enums the design names", () => {
    expect(PAYMENT_BASES).toEqual(["invoice", "delivery", "grn", "dispatch", "bl", "other"]);
    expect(PAYMENT_INSTRUMENTS).toEqual(["tt", "lc", "pdc", "other"]);
    expect(ONE_SIDED_SUBTYPES).toContain("unlimited_liability");
    expect(ONE_SIDED_SUBTYPES).toContain("audit_right");
  });

  it("compares by rule, by the LLM judge, or both, as the table says", () => {
    expect(CLAUSE_TAXONOMY.payment_terms.llm_wording).toBe(false);
    expect(CLAUSE_TAXONOMY.warranty.rule_fields).toEqual(["months", "from"]);
    expect(CLAUSE_TAXONOMY.warranty.llm_wording).toBe(true);
    expect(CLAUSE_TAXONOMY.ld_penalty.llm_wording).toBe(true);
    for (const k of ["inspection_acceptance", "cancellation", "jurisdiction", "one_sided"]) {
      expect(CLAUSE_TAXONOMY[k].rule_fields).toEqual([]);
      expect(CLAUSE_TAXONOMY[k].llm_wording).toBe(true);
    }
  });
});

describe("valueFitsShape", () => {
  it.each([
    ["payment_terms", { days: 60, basis: "grn", advance_pct: 0, instrument: "tt" }],
    ["payment_terms", { days: null, basis: null, advance_pct: 100, instrument: null }],
    ["freight_insurance", { freight: "extra", insurance: "buyer", packing: { pct: 2 } }],
    ["validity", { days: null, expires_at: "2026-12-31" }],
    ["ld_penalty", { rate_pct: 0.5, per: "week", cap_pct: null, excluded: false }],
    ["one_sided", { subtype: "set_off" }],
    ["jurisdiction", null],
  ])("accepts %s %j", (clause, value) => {
    expect(valueFitsShape(clause, value)).toBe(true);
  });

  it.each([
    ["payment_terms", { days: "60", basis: "grn" }],
    ["payment_terms", { days: 60, basis: "receipt" }],
    ["payment_terms", { days: 60, credit: true }],
    ["freight_insurance", { freight: { pct: "2" } }],
    ["validity", { expires_at: "31.12.2026" }],
    ["one_sided", { subtype: "unfair" }],
    ["not_a_clause", {}],
    ["taxes", ["extra"]],
  ])("refuses %s %j", (clause, value) => {
    expect(valueFitsShape(clause, value)).toBe(false);
  });
});

describe("DEFAULT_TERMS_POLICY (section 5.2 as data)", () => {
  const P = DEFAULT_TERMS_POLICY;
  const levelOrNull = (v) => v === null || SEVERITY_LEVELS.includes(v);

  it("has a policy for every clause, every one enabled", () => {
    expect(Object.keys(P.clauses)).toEqual([...CLAUSE_KEYS]);
    for (const k of CLAUSE_KEYS) expect(P.clauses[k].enabled).toBe(true);
  });

  it("asks for a decision at warn and above, and rates an unread PO high", () => {
    expect(P.decide_at_or_above).toBe("warn");
    expect(P.not_read).toBe("high");
    expect(P.version).toBe(1);
    expect(OUTCOMES).toContain("not_read");
  });

  it("uses only the four severity levels, or null where an outcome does not apply", () => {
    for (const k of CLAUSE_KEYS) {
      for (const [key, v] of Object.entries(P.clauses[k].severity)) {
        if (key === "po_only_by_subtype") {
          for (const s of Object.values(v)) expect(SEVERITY_LEVELS).toContain(s);
        } else {
          expect(levelOrNull(v)).toBe(true);
        }
      }
    }
  });

  it("rates a quote-only clause info, for every clause", () => {
    for (const k of CLAUSE_KEYS) expect(P.clauses[k].severity.quote_only).toBe("info");
  });

  it.each([
    ["incoterm", { deviates_against: "high", deviates_against_place_only: "warn", deviates_for: "info", po_only: "warn", unknown: "warn" }],
    ["payment_terms", { deviates_against: "high", deviates_for: "info", po_only: "warn", unknown: "warn" }],
    ["freight_insurance", { deviates_against: "warn", po_only: "warn", unknown: "warn" }],
    ["validity", { deviates_against: "warn", po_only: null, unknown: "info" }],
    ["ld_penalty", { deviates_against: "high", deviates_against_uncapped: "critical", po_only: "high", po_only_uncapped: "critical", unknown: "high" }],
    ["inspection_acceptance", { deviates_against: "warn", po_only: "warn", unknown: "info" }],
    ["cancellation", { deviates_against: "high", po_only: "high", unknown: "warn" }],
    ["jurisdiction", { deviates_against: "warn", po_only: "warn", unknown: "info" }],
  ])("%s matches the severity table", (clause, cells) => {
    expect(P.clauses[clause].severity).toMatchObject(cells);
  });

  it("rates one-sided clauses by subtype, and never as a deviation", () => {
    const s = P.clauses.one_sided.severity;
    expect(s.deviates_against).toBeNull();
    expect(s.deviates_for).toBeNull();
    expect(s.po_only_by_subtype).toMatchObject({
      unlimited_liability: "critical", consequential_damages: "critical",
      indemnity: "high", set_off: "high", bank_guarantee: "high", retention: "high",
      back_to_back_payment: "high", ip_assignment: "high",
      audit_right: "warn", other: "warn",
    });
    expect(Object.keys(s.po_only_by_subtype).sort()).toEqual([...ONE_SIDED_SUBTYPES].sort());
  });

  it("cannot be changed in place, so a tenant override never edits the default", () => {
    expect(Object.isFrozen(P)).toBe(true);
    expect(Object.isFrozen(P.clauses.ld_penalty.severity)).toBe(true);
    // Modules are strict, so writing to a frozen object throws.
    expect(() => { P.clauses.ld_penalty.severity.unknown = "info"; }).toThrow();
    expect(P.clauses.ld_penalty.severity.unknown).toBe("high");
  });
});
