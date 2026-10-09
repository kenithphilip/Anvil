// The clause normalizers: wording in, the structured value out.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 3.2. A deterministic normalizer
// derives each clause's value from its wording, and the comparators compare
// those values, never the words. Every case below is table-driven, and the
// wording is the messy kind real POs and quotes print. Every value is
// invented.

import { describe, it, expect } from "vitest";
import {
  normalizePaymentTerms, normalizeIncoterm, normalizeLeadTime, normalizePriceBasis,
  normalizeFreightInsurance, normalizeTaxes, normalizeValidity, normalizeWarranty,
  normalizeLdPenalty, normalizeClause, NORMALIZERS, parseIncoterm,
} from "../api/_lib/terms/normalize.js";
import { parseIncoterm as reExported } from "../api/_lib/quote-reconcile.js";
import { valueFitsShape, CLAUSE_KEYS } from "../api/_lib/terms/taxonomy.js";

const pay = (days, basis, advance_pct, instrument = null) => ({ days, basis, advance_pct, instrument });

describe("normalizePaymentTerms", () => {
  it.each([
    ["30 days from invoice", pay(30, "invoice", 0)],
    ["Net 45", pay(45, "invoice", 0)],
    ["Net30", pay(30, "invoice", 0)],
    ["50% advance balance against delivery", pay(0, "delivery", 50)],
    ["PDC 60 days", pay(60, "invoice", 0, "pdc")],
    ["Payment: 60 days from the date of GRN", pay(60, "grn", 0)],
    ["sixty days from GRN", pay(60, "grn", 0)],
    ["Within thirty (30) days of receipt of invoice", pay(30, "invoice", 0)],
    ["45 days from receipt of material or invoice whichever is later", pay(45, "grn", 0)],
    ["30 days from date of dispatch or GRN, whichever is earlier", pay(30, "dispatch", 0)],
    ["30% advance, balance 70% within 30 days of invoice", pay(30, "invoice", 30)],
    ["10% along with PO, balance against dispatch", pay(0, "dispatch", 10)],
    ["100% advance along with PO", pay(null, null, 100)],
    ["T/T 100% in advance", pay(null, null, 100, "tt")],
    ["Against proforma invoice", pay(null, null, 100)],
    ["Advance", pay(null, null, 100)],
    ["Against Delivery", pay(0, "delivery", 0)],
    ["Immediate", pay(0, "invoice", 0)],
    ["LC at sight", pay(0, null, 0, "lc")],
    ["90 days LC from BL date", pay(90, "bl", 0, "lc")],
    ["2 months credit", pay(60, "invoice", 0)],
    ["PAYMENT : 30 Days credit", pay(30, "invoice", 0)],
  ])("%s", (text, value) => {
    expect(normalizePaymentTerms(text)).toEqual(value);
  });

  it.each([[""], [null], ["As per agreement"], ["To be discussed"]])("reads nothing from %s", (text) => {
    expect(normalizePaymentTerms(text)).toBeNull();
  });
});

describe("normalizeIncoterm reuses the incoterm check's parser", () => {
  it.each([
    ["Ex-Works Pune", { code: "EXW", place: "Pune" }],
    ["FCA Chennai (Incoterms 2020)", { code: "FCA", place: "Chennai" }],
    ["F.O.B. Busan", { code: "FOB", place: "Busan" }],
    ["FOR destination", { code: "FOR", place: "destination" }],
    ["C&F Nhava Sheva", { code: "CFR", place: "Nhava Sheva" }],
  ])("%s", (text, value) => {
    expect(normalizeIncoterm(text)).toEqual(value);
  });

  it("returns null for text that names no rule", () => {
    expect(normalizeIncoterm("30 days credit")).toBeNull();
    expect(normalizeIncoterm("")).toBeNull();
  });

  it("is the same function the reconciler imports", () => {
    expect(reExported).toBe(parseIncoterm);
  });
});

const lead = (min_days, max_days, from, fixed_date = null) => ({ min_days, max_days, from, fixed_date });

describe("normalizeLeadTime", () => {
  it.each([
    ["within 4 weeks of PO", lead(null, 28, "order")],
    ["11-12 weeks from receipt of order", lead(77, 84, "order")],
    ["8 to 10 weeks ARO", lead(56, 70, "order")],
    ["6-8 weeks from date of drawing approval", lead(42, 56, "drawing_approval")],
    ["4 weeks from receipt of advance", lead(28, 28, "advance")],
    ["Ex-stock, subject to prior sale", lead(0, 0, null)],
    ["Delivery: 30 days", lead(30, 30, null)],
    ["within a fortnight", lead(null, 14, null)],
    ["Delivery on or before 15.11.2026", lead(null, null, null, "2026-11-15")],
    ["Delivery by 15 Nov 2026", lead(null, null, null, "2026-11-15")],
    // The date is the PO's, not a deadline.
    ["4 weeks from PO dated 12.09.2026", lead(28, 28, "order")],
  ])("%s", (text, value) => {
    expect(normalizeLeadTime(text)).toEqual(value);
  });

  it("reads nothing from a schedule with no period or date", () => {
    expect(normalizeLeadTime("As per schedule")).toBeNull();
  });
});

describe("normalizePriceBasis", () => {
  it.each([
    ["Ex-Works Pune", { basis: "ex_works", place: "Pune" }],
    ["EXW Chennai", { basis: "ex_works", place: "Chennai" }],
    ["Ex-godown Bhiwandi", { basis: "ex_works", place: "Bhiwandi" }],
    ["FOR destination", { basis: "for_destination", place: null }],
    ["Free on Road destination", { basis: "for_destination", place: null }],
    ["F.O.R. Chakan", { basis: "for_destination", place: "Chakan" }],
    ["FOR dispatch point", { basis: "for_dispatch", place: null }],
    ["Price basis: FOR our works", { basis: "for_dispatch", place: null }],
    ["Door delivery", { basis: "door_delivery", place: null }],
  ])("%s", (text, value) => {
    expect(normalizePriceBasis(text)).toEqual(value);
  });

  it("does not read the English word 'for' as FOR", () => {
    expect(normalizePriceBasis("Prices are firm for this order")).toBeNull();
  });
});

describe("normalizeFreightInsurance", () => {
  const fi = (freight, insurance, packing) => ({ freight, insurance, packing });
  it.each([
    ["Freight & insurance extra", fi("extra", "extra", null)],
    ["P&F 2% extra", fi(null, null, { pct: 2 })],
    ["Freight: to pay basis, Insurance: by buyer, Packing: included", fi("buyer", "buyer", "included")],
    ["Prices are inclusive of packing and forwarding; freight and transit insurance extra at actuals", fi("extra", "extra", "included")],
    ["Freight paid by us", fi("seller", null, null)],
    ["Prices incl. freight", fi("included", null, null)],
    ["Transit insurance: our scope", fi(null, "seller", null)],
  ])("%s", (text, value) => {
    expect(normalizeFreightInsurance(text)).toEqual(value);
  });

  it("reads nothing when no item is named", () => {
    expect(normalizeFreightInsurance("Prices are firm")).toBeNull();
  });
});

describe("normalizeTaxes", () => {
  it.each([
    ["GST @ 18% extra", { gst: "extra", rate_pct: 18 }],
    ["GST as applicable", { gst: "extra", rate_pct: null }],
    ["Taxes extra", { gst: "extra", rate_pct: null }],
    ["plus GST", { gst: "extra", rate_pct: null }],
    ["CGST 9% + SGST 9% extra", { gst: "extra", rate_pct: 18 }],
    ["Prices inclusive of all taxes", { gst: "inclusive", rate_pct: null }],
    ["Inclusive of GST 18%", { gst: "inclusive", rate_pct: 18 }],
    // "Inclusive" governs the packing, not the tax.
    ["Inclusive of packing, GST extra", { gst: "extra", rate_pct: null }],
    ["GST: 18%", { gst: null, rate_pct: 18 }],
  ])("%s", (text, value) => {
    expect(normalizeTaxes(text)).toEqual(value);
  });

  it("reads nothing when no tax is named", () => {
    expect(normalizeTaxes("Prices firm")).toBeNull();
  });
});

describe("normalizeValidity", () => {
  it.each([
    ["One(1) Month", {}, { days: 30, expires_at: null }],
    ["valid for 2 weeks", {}, { days: 14, expires_at: null }],
    ["Valid till 31.12.2026", {}, { days: null, expires_at: "2026-12-31" }],
    ["Valid until 31-Dec-2026", {}, { days: null, expires_at: "2026-12-31" }],
    // The printed date is the start, not the expiry.
    ["30 days from 01.09.2026", {}, { days: 30, expires_at: "2026-10-01" }],
    ["30 days", { from: "2026-09-01" }, { days: 30, expires_at: "2026-10-01" }],
  ])("%s %o", (text, opts, value) => {
    expect(normalizeValidity(text, opts)).toEqual(value);
  });

  it("reads nothing with no period and no date", () => {
    expect(normalizeValidity("Subject to confirmation")).toBeNull();
  });
});

describe("normalizeWarranty (months and start; scope is wording for the judge)", () => {
  it.each([
    ["12 months from date of commissioning or 18 months from dispatch, whichever is earlier", { months: 12, from: "commissioning", scope: null }],
    ["1 year from date of supply", { months: 12, from: "delivery", scope: null }],
    ["24 months from installation", { months: 24, from: "installation", scope: null }],
    ["18 months from date of invoice", { months: 18, from: "dispatch", scope: null }],
    ["Two (2) years", { months: 24, from: null, scope: null }],
    ["Warranty: Nil", { months: 0, from: null, scope: null }],
  ])("%s", (text, value) => {
    expect(normalizeWarranty(text)).toEqual(value);
  });

  it("reads nothing from a warranty with no period", () => {
    expect(normalizeWarranty("Standard warranty")).toBeNull();
  });
});

describe("normalizeLdPenalty (the numbers; the wording is for the judge)", () => {
  const ld = (rate_pct, per, cap_pct, excluded = false) => ({ rate_pct, per, cap_pct, excluded });
  it.each([
    ["LD @ 0.5% per week of delay, max 5% of order value", ld(0.5, "week", 5)],
    ["Liquidated damages at 1% per day subject to maximum of 10% of contract value", ld(1, "day", 10)],
    ["LD: 0.5% for each week of delay", ld(0.5, "week", null)],
    ["1/2% per week", ld(0.5, "week", null)],
    // No cap stated is an uncapped LD.
    ["LD 0.5% per day without any cap", ld(0.5, "day", null)],
    ["LD not applicable", ld(null, null, null, true)],
    ["LD: NA", ld(null, null, null, true)],
    ["No LD", ld(null, null, null, true)],
  ])("%s", (text, value) => {
    expect(normalizeLdPenalty(text)).toEqual(value);
  });

  it("reads nothing from LD wording with no figure", () => {
    expect(normalizeLdPenalty("Penalty clause applies")).toBeNull();
  });
});

describe("every normalizer's value fits its clause's shape", () => {
  const SAMPLES = {
    incoterm: "FCA Chennai",
    payment_terms: "50% advance balance against delivery",
    delivery_lead_time: "11-12 weeks from receipt of order",
    price_basis: "Ex-Works Pune",
    freight_insurance: "P&F 2% extra, freight to pay",
    taxes: "GST @ 18% extra",
    validity: "Valid till 31.12.2026",
    warranty: "18 months from date of invoice",
    ld_penalty: "LD @ 0.5% per week of delay, max 5% of order value",
  };

  it.each(Object.entries(SAMPLES))("%s", (clause, text) => {
    const value = normalizeClause(clause, text);
    expect(value).not.toBeNull();
    expect(valueFitsShape(clause, value)).toBe(true);
  });

  it("covers every rule-normalized clause, and only taxonomy keys", () => {
    expect(Object.keys(NORMALIZERS).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const k of Object.keys(NORMALIZERS)) expect(CLAUSE_KEYS).toContain(k);
  });

  it("returns null for a clause that only the LLM judge reads", () => {
    expect(normalizeClause("jurisdiction", "Courts at Pune only")).toBeNull();
    expect(normalizeClause("not_a_clause", "anything")).toBeNull();
  });

  it("passes opts through to the validity normalizer", () => {
    expect(normalizeClause("validity", "30 days", { from: "2026-09-01" }).expires_at).toBe("2026-10-01");
  });
});
