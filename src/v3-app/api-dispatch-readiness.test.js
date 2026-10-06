// Can the consignment behind this invoice lawfully move?
//
// #538 added an under-delivery leg — are we billing more than we shipped. For
// this tenant that is vacuous: invoicing IS the despatch event, so nothing can
// be invoiced that has not left the store. The owner's description of their
// Tally despatch register named what actually holds a consignment instead: the
// docket number and the e-way bill details.
//
// The load-bearing property in every test below is REFUSAL. When the value or
// the place of supply cannot be determined, `required` must be null and never
// false — because a silent pass on a detainable consignment is the worst
// outcome this module can produce.

import { describe, it, expect } from "vitest";
import {
  assessDispatchReadiness, ewayRequired, placeOfSupply,
  DEFAULT_EWAY_THRESHOLD_INR, USABLE_EWAY_STATUS, UNUSABLE_EWAY_STATUSES,
} from "../api/_lib/dispatch-readiness.js";

// Shape-valid GSTINs differing only in the leading state code. Synthetic.
const GST_27 = "27AAAAA0000A1Z5";   // Maharashtra
const GST_29 = "29AAAAA0000A1Z5";   // Karnataka

const FILED = { status: "GENERATED", ewb_no: "123456789012", vehicle_no: "MH12AB1234", trans_mode: "Road" };

describe("place of supply", () => {
  it("reads intrastate when both GSTINs share a state code", () => {
    expect(placeOfSupply(GST_27, GST_27)).toBe("intrastate");
  });

  it("reads interstate when they differ", () => {
    expect(placeOfSupply(GST_27, GST_29)).toBe("interstate");
  });

  it("refuses when either GSTIN is missing or malformed", () => {
    // null, never a guess in either direction.
    expect(placeOfSupply(GST_27, null)).toBeNull();
    expect(placeOfSupply(null, GST_29)).toBeNull();
    expect(placeOfSupply(GST_27, "nonsense")).toBeNull();
  });
});

describe("is an e-way bill required", () => {
  it("required at or above the threshold", () => {
    const r = ewayRequired({ invoiceValue: 50000, sellerGstin: GST_27, buyerGstin: GST_29 });
    expect(r.required).toBe(true);
    expect(r.threshold).toBe(DEFAULT_EWAY_THRESHOLD_INR);
    expect(r.place_of_supply).toBe("interstate");
  });

  it("not required below it", () => {
    expect(ewayRequired({ invoiceValue: 49999, sellerGstin: GST_27, buyerGstin: GST_29 }).required).toBe(false);
  });

  it("uses the intrastate threshold for intrastate movement", () => {
    // These genuinely differ between states, which is why both are settings.
    const r = ewayRequired({
      invoiceValue: 60000, sellerGstin: GST_27, buyerGstin: GST_27,
      settings: { eway_threshold_intrastate_inr: 100000, eway_threshold_inr: 50000 },
    });
    expect(r.place_of_supply).toBe("intrastate");
    expect(r.threshold).toBe(100000);
    expect(r.required).toBe(false);
  });

  it("refuses — null, not false — with no consignment value", () => {
    const r = ewayRequired({ invoiceValue: null, sellerGstin: GST_27, buyerGstin: GST_29 });
    expect(r.required).toBeNull();
    expect(r.reason).toBe("threshold_unknown");
  });

  it("refuses — null, not false — when the place of supply is unknown", () => {
    const r = ewayRequired({ invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: null });
    expect(r.required).toBeNull();
    expect(r.reason).toBe("place_of_supply_unknown");
  });

  it("a null setting falls back to the documented default rather than to zero", () => {
    // Zero would make every consignment require a bill.
    const r = ewayRequired({
      invoiceValue: 100, sellerGstin: GST_27, buyerGstin: GST_29,
      settings: { eway_threshold_inr: null },
    });
    expect(r.threshold).toBe(DEFAULT_EWAY_THRESHOLD_INR);
    expect(r.required).toBe(false);
  });
});

describe("dispatch readiness", () => {
  it("is ready when the bill is filed and a docket exists", () => {
    const r = assessDispatchReadiness({
      invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: FILED, docket: "DKT-4471",
    });
    expect(r.findings.map((f) => f.verdict)).toEqual(["ready"]);
    expect(r.can_dispatch).toBe(true);
    expect(r.eway.filed).toBe(true);
  });

  it("blocks when a bill is required and none is on file", () => {
    const r = assessDispatchReadiness({
      invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: null, docket: "DKT-4471",
    });
    expect(r.findings[0].verdict).toBe("eway_missing");
    expect(r.findings[0].blocking).toBe(true);
    expect(r.can_dispatch).toBe(false);
  });

  it.each(UNUSABLE_EWAY_STATUSES)("blocks on a bill that is %s, not GENERATED", (status) => {
    // Worse than absent: someone believes there is a bill.
    const r = assessDispatchReadiness({
      invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: { ...FILED, status }, docket: "DKT-4471",
    });
    expect(r.findings[0].verdict).toBe("eway_not_filed");
    expect(r.findings[0].blocking).toBe(true);
    expect(r.eway.filed).toBe(false);
  });

  it("does not require a bill below the threshold", () => {
    const r = assessDispatchReadiness({
      invoiceValue: 4000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: null, docket: "DKT-4471",
    });
    expect(r.can_dispatch).toBe(true);
    expect(r.eway.required).toBe(false);
  });

  it("flags a road bill with no vehicle without blocking the invoice", () => {
    // The paperwork exists; the vehicle cannot carry it yet. That is the
    // operator's problem to fix now rather than at the gate.
    const r = assessDispatchReadiness({
      invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: { ...FILED, vehicle_no: null }, docket: "DKT-4471",
    });
    const v = r.findings.map((f) => f.verdict);
    expect(v).toContain("eway_vehicle_missing");
    expect(r.findings.find((f) => f.verdict === "eway_vehicle_missing").blocking).toBe(false);
  });

  it("flags a missing docket even when no bill is required", () => {
    // Independent legs: a small consignment still needs something the buyer's
    // stores can match it on.
    const r = assessDispatchReadiness({
      invoiceValue: 4000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: null, docket: null,
    });
    expect(r.findings.map((f) => f.verdict)).toContain("docket_missing");
  });

  it("takes the docket off the e-way bill when the register has none", () => {
    const r = assessDispatchReadiness({
      invoiceValue: 4000, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: { ...FILED, lr_number: "LR-88" }, docket: null,
    });
    expect(r.docket).toBe("LR-88");
    expect(r.findings.map((f) => f.verdict)).not.toContain("docket_missing");
  });

  it("REFUSES rather than passing when the value is unknown", () => {
    // The whole point. can_dispatch must not be true on an undecided check.
    const r = assessDispatchReadiness({
      invoiceValue: null, sellerGstin: GST_27, buyerGstin: GST_29,
      ewayBill: null, docket: "DKT-4471",
    });
    expect(r.findings[0].verdict).toBe("threshold_unknown");
    expect(r.findings[0].decided).toBe(false);
    expect(r.eway.required).toBeNull();
    expect(r.can_dispatch).toBe(false);
    expect(r.summary.undecided).toBe(1);
  });

  it("REFUSES when the place of supply cannot be determined", () => {
    const r = assessDispatchReadiness({
      invoiceValue: 80000, sellerGstin: GST_27, buyerGstin: null,
      ewayBill: null, docket: "DKT-4471",
    });
    expect(r.findings[0].verdict).toBe("place_of_supply_unknown");
    expect(r.can_dispatch).toBe(false);
  });

  it("an empty call refuses on every leg rather than reporting ready", () => {
    const r = assessDispatchReadiness();
    expect(r.can_dispatch).toBe(false);
    expect(r.findings.map((f) => f.verdict)).toContain("threshold_unknown");
  });

  it("GENERATED is the only status that counts as filed", () => {
    expect(USABLE_EWAY_STATUS).toBe("GENERATED");
    expect(UNUSABLE_EWAY_STATUSES).toContain("PENDING_NIC");
    expect(UNUSABLE_EWAY_STATUSES).not.toContain("GENERATED");
  });
});
