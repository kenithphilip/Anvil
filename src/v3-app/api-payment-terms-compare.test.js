// comparePaymentTerms compares the parts of a payment term, not the day count.
//
// It used to compare the credit days only, so "60 days from GRN" matched
// "60 days from invoice" (the GRN clock starts later, which costs us), and
// "50% advance, balance 30 days" matched "30 days". Now both sides go through
// normalizePaymentTerms and the days, the basis, the advance and (when both
// name one) the instrument are compared. docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// sections 2.2 and 5.1. Every value is invented.

import { describe, it, expect } from "vitest";
import { comparePaymentTerms } from "../api/_lib/quote-reconcile.js";

describe("comparePaymentTerms: the same terms written differently", () => {
  it.each([
    ["Net 45", "45 days from invoice"],
    ["30 Days credit", "PAYMENT : 30 Days"],
    ["Within thirty (30) days of receipt of invoice", "30 days from date of invoice"],
    ["50% advance balance against delivery", "50% Advance, Balance against Delivery"],
    ["Against Delivery", "against  delivery"],
    ["60 days from GRN", "sixty days from date of goods receipt"],
  ])("%s matches %s", (po, quote) => {
    const r = comparePaymentTerms(po, quote);
    expect(r.verdict).toBe("match");
    expect(r.differs).toEqual([]);
  });
});

describe("comparePaymentTerms: the basis and the advance count now", () => {
  it("flags a later clock with the same day count", () => {
    const r = comparePaymentTerms("Payment: 60 days from the date of GRN", "60 days from invoice");
    expect(r.verdict).toBe("mismatch");
    expect(r.differs).toEqual(["basis"]);
    expect(r).toMatchObject({ po_days: 60, quote_days: 60, po_basis: "grn", quote_basis: "invoice" });
  });

  it("reads a credit period with no stated clock as running from the invoice", () => {
    const r = comparePaymentTerms("60 days from GRN", "60 days");
    expect(r.verdict).toBe("mismatch");
    expect(r.differs).toEqual(["basis"]);
  });

  it("flags less advance with the same day count", () => {
    const r = comparePaymentTerms("30 days from invoice", "50% advance, balance 30 days from invoice");
    expect(r.verdict).toBe("mismatch");
    expect(r.differs).toEqual(["advance_pct"]);
    expect(r).toMatchObject({ po_advance_pct: 0, quote_advance_pct: 50 });
  });

  it("flags full advance against a credit period", () => {
    const r = comparePaymentTerms("Advance", "Against Delivery");
    expect(r.verdict).toBe("mismatch");
    expect(r.differs).toContain("advance_pct");
  });

  it("still flags a changed credit period", () => {
    const r = comparePaymentTerms("60 days credit", "30 Days credit");
    expect(r.verdict).toBe("mismatch");
    expect(r.differs).toEqual(["days"]);
    expect(r).toMatchObject({ po_days: 60, quote_days: 30 });
  });

  it("flags a different instrument only when both sides name one", () => {
    expect(comparePaymentTerms("PDC 60 days", "60 days by RTGS").differs).toEqual(["instrument"]);
    expect(comparePaymentTerms("PDC 60 days", "60 days").verdict).toBe("match");
  });
});

describe("comparePaymentTerms: what it cannot read is unknown, not a mismatch", () => {
  it("is unknown when either side is missing", () => {
    expect(comparePaymentTerms(null, "30 days").verdict).toBe("unknown");
    expect(comparePaymentTerms("30 days", "  ").verdict).toBe("unknown");
  });

  it("is unknown when one side names nothing readable", () => {
    const r = comparePaymentTerms("As per our rate contract", "30 days from invoice");
    expect(r.verdict).toBe("unknown");
    expect(r.po_days).toBeNull();
  });

  it("is unknown when the two sides state no part in common", () => {
    // An instrument alone against a credit period with none named.
    expect(comparePaymentTerms("By PDC", "30 days").verdict).toBe("unknown");
  });

  it("still matches the same unreadable words on both sides", () => {
    expect(comparePaymentTerms("As per rate contract", "as per  RATE contract").verdict).toBe("match");
  });

  it("keeps the PO and quote wording for the banner", () => {
    const r = comparePaymentTerms("60 days from GRN", "60 days");
    expect(r.po_terms).toBe("60 days from GRN");
    expect(r.quote_terms).toBe("60 days");
  });
});
