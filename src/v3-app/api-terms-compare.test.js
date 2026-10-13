// The terms rule comparator (plan PR 12): each structured clause compared
// field by field, the outcome and direction it reaches, the severity the
// policy gives it, the not_read row, and the provenance labels.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md sections 3.3, 5.1 to 5.3. Every clause
// here is invented wording; no customer text.

import { describe, it, expect } from "vitest";
import {
  compareClause, compareTerms, compareValidity, effectivePolicy, severityFor, needsDecision,
  sortFlags, checkFingerprint, stableStringify, flagTextHash,
} from "../api/_lib/terms/compare.js";
import {
  poClausesFromExtraction, quoteClauses, normalizePassResult, customerBaseline,
} from "../api/_lib/terms/sides.js";
import { provenanceLabel, labelled } from "../api/_lib/terms/labels.js";

const po = (clause, text, extra = {}) => ({ clause, side: "po", text, value: null, provenance: "po_text", verified: true, ...extra });
const qt = (clause, text, extra = {}) => ({ clause, side: "quote", text, value: null, provenance: "quote_document", ...extra });
const POLICY = effectivePolicy(null);

// The outcome, direction and default severity of one clause.
const judge = (clause, poText, quoteText, ctx) => {
  const res = compareClause(clause, poText == null ? null : po(clause, poText), quoteText == null ? null : qt(clause, quoteText), ctx);
  return { outcome: res.outcome, direction: res.direction, severity: severityFor(POLICY, clause, res.outcome, res.direction, res.refine) };
};

describe("each structured comparison: match, stricter (against us), looser (for us), unknown", () => {
  it("incoterm compares the rule by who carries the cost, then the named place", () => {
    expect(judge("incoterm", "FCA Chennai", "FCA Chennai").outcome).toBe("match");
    expect(judge("incoterm", "DDP Pune", "FCA Chennai")).toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("incoterm", "EXW Chennai", "FCA Chennai")).toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    // Same rule, another place: the default policy's place-only key.
    expect(judge("incoterm", "FCA Pune", "FCA Chennai")).toEqual({ outcome: "deviates", direction: "against_us", severity: "warn" });
    expect(judge("incoterm", "as mutually agreed", "FCA Chennai")).toEqual({ outcome: "unknown", direction: null, severity: "warn" });
  });

  it("payment terms compare the days, the clock, the advance and the instrument", () => {
    expect(judge("payment_terms", "Net 30", "30 days from invoice").outcome).toBe("match");
    expect(judge("payment_terms", "Payment 60 days from the date of GRN", "30 days from invoice"))
      .toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("payment_terms", "15 days from invoice", "30 days from invoice"))
      .toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    // Less advance is more of our money at risk.
    expect(judge("payment_terms", "30 days from invoice", "50% advance, balance 30 days from invoice").direction).toBe("against_us");
    expect(judge("payment_terms", "as per our vendor policy", "30 days from invoice"))
      .toEqual({ outcome: "unknown", direction: null, severity: "warn" });
  });

  it("delivery lead time: a PO that needs it sooner is against us", () => {
    expect(judge("delivery_lead_time", "within 4 weeks from PO", "4 weeks from order").outcome).toBe("match");
    expect(judge("delivery_lead_time", "within 2 weeks from PO", "4 weeks from order"))
      .toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("delivery_lead_time", "8 weeks from PO", "4 weeks from order"))
      .toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    // A dated delivery is read against the PO date plus the quoted period.
    expect(judge("delivery_lead_time", "Delivery by 05.10.2026", "4 weeks from order", { poDate: "2026-09-21" }).direction).toBe("against_us");
    expect(judge("delivery_lead_time", "Delivery by 30.10.2026", "4 weeks from order", { poDate: "2026-09-21" }).direction).toBe("for_us");
    expect(judge("delivery_lead_time", "as per schedule to follow", "4 weeks from order").outcome).toBe("unknown");
  });

  it("price basis: delivered to the buyer costs us more than ex works", () => {
    expect(judge("price_basis", "Ex-Works Pune", "Ex works Pune").outcome).toBe("match");
    expect(judge("price_basis", "Door delivery", "Ex-Works Pune")).toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("price_basis", "Ex-Works Pune", "FOR destination")).toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    expect(judge("price_basis", "as discussed", "Ex-Works Pune").outcome).toBe("unknown");
  });

  it("freight, insurance and packing: included in the price is our cost", () => {
    expect(judge("freight_insurance", "Freight and insurance extra", "Freight & insurance extra").outcome).toBe("match");
    expect(judge("freight_insurance", "Prices inclusive of freight", "Freight extra"))
      .toEqual({ outcome: "deviates", direction: "against_us", severity: "warn" });
    expect(judge("freight_insurance", "Freight extra", "Prices inclusive of freight"))
      .toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    expect(judge("freight_insurance", "Freight as applicable", "Freight extra").outcome).toBe("unknown");
  });

  it("taxes: inclusive of GST against GST extra is against us", () => {
    expect(judge("taxes", "GST extra at 18%", "GST 18% extra").outcome).toBe("match");
    expect(judge("taxes", "Prices inclusive of all taxes", "GST extra")).toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("taxes", "GST extra", "Prices inclusive of all taxes")).toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    expect(judge("taxes", "Statutory levies apply", "GST extra").outcome).toBe("unknown");
  });

  it("validity: a PO dated after the quote expired", () => {
    const q = qt("validity", "valid till 30.09.2026");
    expect(compareValidity(q, "2026-09-15").outcome).toBe("match");
    const late = compareValidity(q, "2026-10-02");
    expect([late.outcome, late.direction, severityFor(POLICY, "validity", late.outcome, late.direction)]).toEqual(["deviates", "against_us", "warn"]);
    const noDate = compareValidity(q, null);
    expect([noDate.outcome, severityFor(POLICY, "validity", noDate.outcome, null)]).toEqual(["unknown", "info"]);
  });

  it("warranty: longer, or a later start, is against us", () => {
    expect(judge("warranty", "12 months from dispatch", "Warranty 12 months from dispatch").outcome).toBe("match");
    expect(judge("warranty", "24 months from dispatch", "12 months from dispatch")).toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("warranty", "12 months from commissioning", "12 months from dispatch").direction).toBe("against_us");
    expect(judge("warranty", "6 months from dispatch", "12 months from dispatch")).toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    expect(judge("warranty", "standard warranty applies", "12 months from dispatch").outcome).toBe("unknown");
  });

  it("LD: uncapped, or LD the quote excluded, is critical; a capped increase is high", () => {
    const capped = "LD 0.5% per week, max 5% of order value";
    expect(judge("ld_penalty", capped, "LD at 0.5% per week, maximum 5%").outcome).toBe("match");
    expect(judge("ld_penalty", "LD 1% per week, max 10%", capped)).toEqual({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(judge("ld_penalty", "LD 1% per day of delay", capped)).toEqual({ outcome: "deviates", direction: "against_us", severity: "critical" });
    expect(judge("ld_penalty", capped, "LD not applicable")).toEqual({ outcome: "deviates", direction: "against_us", severity: "critical" });
    expect(judge("ld_penalty", "LD not applicable", capped)).toEqual({ outcome: "deviates", direction: "for_us", severity: "info" });
    expect(judge("ld_penalty", "penalty as per clause 14", capped).outcome).toBe("unknown");
  });
});

describe("presence: po_only, quote_only, and wording the rules do not judge", () => {
  it("a clause the PO imposes and the quote is silent on", () => {
    expect(judge("ld_penalty", "LD 1% per day of delay", null)).toEqual({ outcome: "po_only", direction: null, severity: "critical" });
    expect(judge("ld_penalty", "LD 0.5% per week, max 5%", null).severity).toBe("high");
    // "No LD" with the quote silent is in our favour, not a high flag.
    expect(judge("ld_penalty", "LD not applicable", null)).toEqual({ outcome: "po_only", direction: "for_us", severity: "info" });
    expect(judge("payment_terms", "60 days from GRN", null).severity).toBe("warn");
  });

  it("one-sided clauses are rated by subtype", () => {
    const one = (subtype) => {
      const r = compareClause("one_sided", po("one_sided", "Seller's liability shall be unlimited.", { value: { subtype } }), null);
      return severityFor(POLICY, "one_sided", r.outcome, r.direction, r.refine);
    };
    expect([one("unlimited_liability"), one("indemnity"), one("audit_right")]).toEqual(["critical", "high", "warn"]);
  });

  it("a clause only the quote states is info", () => {
    expect(judge("warranty", null, "12 months from dispatch")).toEqual({ outcome: "quote_only", direction: null, severity: "info" });
  });

  it("wording-only clauses on both sides are unknown, never a silent pass", () => {
    const r = compareClause("jurisdiction", po("jurisdiction", "Courts at City A only."), qt("jurisdiction", "Courts at City B."));
    expect(r.outcome).toBe("unknown");
    const [flag] = compareTerms({
      poStatus: "read", poClauses: [po("jurisdiction", "Courts at City A only.")],
      quotes: [{ quote_id: "q1", quote_number: "Q-1", primary: true, clauses: [qt("jurisdiction", "Courts at City B.")] }],
      policy: POLICY,
    });
    expect(flag.rationale).toContain("Anvil does not compare this wording yet");
  });
});

describe("severity comes from the tenant policy, falling back to the default", () => {
  const deviates = (policy) => compareTerms({
    poStatus: "read", poClauses: [po("payment_terms", "60 days from GRN")],
    quotes: [{ quote_id: "q1", quote_number: "Q-1", primary: true, clauses: [qt("payment_terms", "30 days from invoice")] }],
    policy,
  });

  it("the default rates a payment term against us high", () => {
    expect(deviates(POLICY).map((f) => f.severity)).toEqual(["high"]);
  });

  it("a tenant override re-rates it, key by key, and keeps the rest of the default", () => {
    const p = effectivePolicy({ version: 3, clauses: { payment_terms: { severity: { deviates_against: "critical" } } } });
    expect(deviates(p).map((f) => f.severity)).toEqual(["critical"]);
    expect(p.version).toBe(3);
    expect(p.clauses.payment_terms.severity.po_only).toBe("warn");
    expect(p.clauses.ld_penalty.severity.po_only_uncapped).toBe("critical");
  });

  it("a disabled clause raises nothing; null turns one outcome off; a bad level is ignored", () => {
    expect(deviates(effectivePolicy({ clauses: { payment_terms: { enabled: false } } }))).toEqual([]);
    expect(deviates(effectivePolicy({ clauses: { payment_terms: { severity: { deviates_against: null } } } }))).toEqual([]);
    expect(deviates(effectivePolicy({ clauses: { payment_terms: { severity: { deviates_against: "urgent" } } } })).map((f) => f.severity)).toEqual(["high"]);
  });

  it("decide_at_or_above sets which flags need a decision", () => {
    expect([needsDecision(POLICY, "info"), needsDecision(POLICY, "warn")]).toEqual([false, true]);
    const strict = effectivePolicy({ decide_at_or_above: "high" });
    expect([needsDecision(strict, "warn"), needsDecision(strict, "high")]).toEqual([false, true]);
  });

  it("accept_requires may only name the high-accept action, so a policy can tighten and never loosen", () => {
    const p = effectivePolicy({ clauses: { warranty: { accept_requires: "order.terms_accept_high" }, taxes: { accept_requires: "order.terms_decide" } } });
    expect(p.clauses.warranty.accept_requires).toBe("order.terms_accept_high");
    expect(p.clauses.taxes.accept_requires).toBeNull();
  });
});

describe("the not_read row", () => {
  it("terms not read is one order-level row, never an empty list", () => {
    const flags = compareTerms({ poStatus: "not_read", poClauses: [], quotes: [{ quote_id: "q1", clauses: [qt("warranty", "12 months")] }], policy: POLICY, notReadReason: "image only" });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ clause: null, outcome: "not_read", severity: "high" });
    expect(flags[0].rationale).toContain("image only");
    expect(flags[0].rationale).toContain("not \"no deviations\"");
  });

  it("the policy can re-rate it", () => {
    const [f] = compareTerms({ poStatus: "not_read", policy: effectivePolicy({ not_read: "critical" }) });
    expect(f.severity).toBe("critical");
  });

  it("a partial read never calls a clause the PO 'is silent' on", () => {
    const quotes = [{ quote_id: "q1", quote_number: "Q-1", primary: true, clauses: [qt("warranty", "12 months from dispatch")] }];
    expect(compareTerms({ poStatus: "partial", poClauses: [], quotes, policy: POLICY })).toEqual([]);
    expect(compareTerms({ poStatus: "read", poClauses: [], quotes, policy: POLICY }).map((f) => f.outcome)).toEqual(["quote_only"]);
  });
});

describe("baselines: every quote that priced a line, primary first", () => {
  it("one flag per quote, sorted by severity then the primary quote", () => {
    const quotes = [
      { quote_id: "q1", quote_number: "Q-1", primary: true, clauses: [qt("payment_terms", "45 days from invoice")] },
      { quote_id: "q2", quote_number: "Q-2", primary: false, clauses: [qt("payment_terms", "30 days from invoice")] },
    ];
    const flags = sortFlags(compareTerms({ poStatus: "read", poClauses: [po("payment_terms", "60 days from invoice")], quotes, policy: POLICY }));
    expect(flags.map((f) => [f.quote.quote_number, f.quote.primary, f.severity])).toEqual([["Q-1", true, "high"], ["Q-2", false, "high"]]);
    expect(flags[0].text_hash).not.toBe(flags[1].text_hash);
  });

  it("with no quote, a PO clause is po_only and says no quote is linked", () => {
    const [f] = compareTerms({ poStatus: "read", poClauses: [po("warranty", "24 months from dispatch")], quotes: [], policy: POLICY });
    expect(f).toMatchObject({ outcome: "po_only", quote: null, severity: "warn" });
    expect(f.rationale).toContain("No quote is linked to this order");
  });
});

describe("provenance: where each side came from, and the labels", () => {
  const customer = { id: "c1", default_payment_terms: "30 days from invoice", default_incoterms: "FCA Chennai" };

  it("a payment term grounding filled from the customer master is a baseline, never the PO side", () => {
    const order = { result: { salesOrder: { customer: { payment_terms: "45 days credit" } } } };
    const out = poClausesFromExtraction({ order, runProvenance: { "customer.payment_terms": "customer_master" }, customer });
    expect(out.clauses).toEqual([]);
    expect(out.baseline[0]).toMatchObject({ provenance: "customer_master", basis: "grounding_marker" });
    expect(provenanceLabel(out.baseline[0])).toBe("from customer master (filled in when the PO stated none)");
  });

  it("an unmarked value equal to the master default is not counted as PO wording", () => {
    const order = { result: { salesOrder: { customer: { payment_terms: "30 Days from Invoice" } } } };
    const out = poClausesFromExtraction({ order, customer });
    expect(out.clauses).toEqual([]);
    expect(out.baseline[0].provenance).toBe("customer_master");
  });

  it("a payment term the PO printed is labelled from PO, read by extraction", () => {
    const order = { result: { salesOrder: { customer: { payment_terms: "60 days from GRN" } } } };
    const [c] = poClausesFromExtraction({ order, customer }).clauses;
    expect(c).toMatchObject({ provenance: "po_text", method: "extraction", value: { days: 60, basis: "grn" } });
    expect(provenanceLabel(c)).toBe("from PO (read by extraction, not the terms reader)");
    expect(provenanceLabel({ ...c, method: "llm:terms_pass@v1", page: 7 })).toBe("from PO, page 7");
  });

  it("header values the operator typed are labelled as theirs", () => {
    const order = { incoterm_code: "DDP Pune", delivery_terms: "within 3 weeks from PO", result: {} };
    const out = poClausesFromExtraction({ order });
    expect(out.clauses.map((c) => [c.clause, c.provenance])).toEqual([["incoterm", "operator_entry"], ["delivery_lead_time", "operator_entry"]]);
    expect(provenanceLabel(out.clauses[0])).toBe("entered on the order header");
  });

  it("quote sides: our quote as held today, our template, an uploaded quote, a snapshot", () => {
    const ours = quoteClauses(
      { id: "q1", quote_number: "Q-1", terms: "30 days from invoice", validity_days: 30, created_at: "2026-09-01T00:00:00Z" },
      { template: { id: "t1", warranty_clause: "12 months from dispatch" } },
    ).map((c) => ({ ...c, quote_number: "Q-1" }));
    const pay = ours.find((c) => c.clause === "payment_terms");
    expect(labelled(pay)).toMatchObject({ label: "from quote Q-1, as held today (not as sent)", printed_note: "on file, not printed on the quote PDF" });
    expect(provenanceLabel(ours.find((c) => c.clause === "warranty"))).toBe("from our quote template, as of today (not as sent)");
    expect(ours.find((c) => c.clause === "validity").value).toEqual({ days: 30, expires_at: "2026-10-01" });

    const uploaded = quoteClauses({ id: "q2", quote_number: "Q-2", ingest_source: "document", incoterm: "FCA Chennai", delivery_terms: "6 weeks from order" });
    expect(uploaded.map((c) => [c.clause, provenanceLabel({ ...c, quote_number: "Q-2" })])).toEqual([
      ["incoterm", "from uploaded quote Q-2"], ["delivery_lead_time", "from uploaded quote Q-2"],
    ]);

    const snap = quoteClauses({ id: "q3", terms: "Net 45", terms_snapshot: { clauses: [{ clause: "payment_terms", text: "Net 30", provenance: "quote_snapshot" }] }, terms_snapshot_at: "2026-09-01T10:00:00Z" });
    expect(snap.find((c) => c.clause === "payment_terms")).toMatchObject({ text: "Net 30", provenance: "quote_snapshot" });
    expect(provenanceLabel({ ...snap[0], quote_number: "Q-3" })).toBe("from quote Q-3, as sent on 2026-09-01");
  });

  it("the customer master is a labelled baseline", () => {
    expect(customerBaseline(customer).map((b) => [b.clause, provenanceLabel(b)])).toEqual([
      ["payment_terms", "from customer master"], ["incoterm", "from customer master"],
    ]);
  });

  it("the terms pass result is held to the record rules: unverified dropped, master moved to the baseline", () => {
    const r = normalizePassResult({
      po_terms_status: "read", po_text_source: "text_layer", prompt_version: "terms_pass@v1",
      po_clauses: [
        po("payment_terms", "60 days from GRN"),
        po("warranty", "36 months", { verified: false }),
        po("no_such_clause", "x"),
        { ...po("incoterm", "FCA Chennai"), provenance: "customer_master" },
      ],
    });
    expect(r.clauses.map((c) => c.clause)).toEqual(["payment_terms"]);
    expect(r.baseline.map((c) => [c.clause, c.side])).toEqual([["incoterm", "baseline"]]);
    expect(normalizePassResult({ status: "something" })).toMatchObject({ status: "not_read", text_source: "none" });
  });
});

describe("hashes", () => {
  it("a value read back with its keys reordered hashes the same", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(stableStringify({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    const flag = { clause: "taxes", outcome: "deviates", severity: "high", method: "rule", text_hash: "h", quote: { quote_id: "q1" } };
    const check = { po_terms_status: "read", quote_ids: ["q2", "q1"], po_clauses: [po("taxes", "GST inclusive")], policy_version: 1 };
    expect(checkFingerprint(check, [flag])).toBe(checkFingerprint({ ...check, quote_ids: ["q1", "q2"] }, [{ ...flag }]));
    expect(checkFingerprint(check, [flag])).not.toBe(checkFingerprint({ ...check, policy_version: 2 }, [flag]));
  });

  it("the text hash ignores case and spacing, and moves with the wording", () => {
    const q = { quote_id: "q1", text: "Net 30" };
    expect(flagTextHash("payment_terms", { text: "60 days  from GRN" }, q)).toBe(flagTextHash("payment_terms", { text: "60 Days from grn" }, q));
    expect(flagTextHash("payment_terms", { text: "60 days from GRN" }, q)).not.toBe(flagTextHash("payment_terms", { text: "90 days from GRN" }, q));
  });
});
