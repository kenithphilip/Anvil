// The customer match basis is saved, and used (plan PR 7).
//
// The intake showed how it matched the customer in a toast and kept nothing,
// so #600's exceptions list had to guess it from the PO and the master. The
// intake now saves { customer_id, basis } in preflight_payload.customer_match,
// a customer change saves "operator", and the list reads it for the order's
// current customer.
//
// Every value is invented.

import { describe, it, expect } from "vitest";
import {
  buildOrderExceptions, customerMatchBasis, customerMatchStamp, matchBasisTone, MATCH_BASIS_LABEL,
} from "../api/_lib/order-exceptions.js";

const C1 = "cust-1";
const master = { id: C1, customer_name: "Fixture Buyer Pvt Ltd", gstin: null, state_code: "27" };
const order = (over = {}) => ({
  id: "o-1", status: "DRAFT", customer_id: C1,
  result: { salesOrder: { customer: { name: "Someone Else Entirely" }, lineItems: [{ partNumber: "P-1", quantity: 1, unitPrice: 5 }] } },
  preflight_payload: {},
  ...over,
});
const types = (out) => out.rows.map((r) => r.type);

describe("the saved basis", () => {
  it("is used for the order's current customer", () => {
    const o = order({ preflight_payload: { customer_match: { customer_id: C1, basis: "letterhead", at: "2026-10-01T00:00:00Z" } } });
    const m = customerMatchBasis({ order: o, customer: master });
    expect(m).toMatchObject({ basis: "letterhead", label: "matched by letterhead", saved: true });
  });

  it("is ignored once the customer has moved on", () => {
    // Saved for another customer: derived again for this one.
    const o = order({ preflight_payload: { customer_match: { customer_id: "cust-9", basis: "gstin" } } });
    expect(customerMatchBasis({ order: o, customer: master }).basis).toBe("unverified");
  });

  it("chosen by hand, it answers the 'not confirmed by the PO' row", () => {
    const derived = buildOrderExceptions({ order: order(), customer: master });
    expect(types(derived)).toContain("customer_low_confidence");
    const picked = buildOrderExceptions({
      order: order({ preflight_payload: { customer_match: { customer_id: C1, basis: "operator", by: "u-1" } } }),
      customer: master,
    });
    expect(types(picked)).not.toContain("customer_low_confidence");
    expect(picked.customer_match).toMatchObject({ basis: "operator", label: "chosen by hand", by: "u-1" });
  });

  it("does not hide a GSTIN the master and the PO disagree on today", () => {
    const o = order({
      result: { salesOrder: { customer: { name: "X", gstin: "27AAAAA0000A1Z5" }, lineItems: [] } },
      preflight_payload: { customer_match: { customer_id: C1, basis: "operator" } },
    });
    const out = buildOrderExceptions({ order: o, customer: { ...master, gstin: "29BBBBB0000B1Z5" } });
    expect(out.customer_match).toMatchObject({ basis: "gstin_conflict", saved_basis: "operator" });
    expect(types(out)).toContain("customer_gstin_conflict");
  });

  it("stands without the master record", () => {
    // The workspace builds the list without the master; the saved basis still shows.
    const o = order({ preflight_payload: { customer_match: { customer_id: C1, basis: "gstin" } } });
    expect(buildOrderExceptions({ order: o }).customer_match).toMatchObject({ basis: "gstin", label: "matched by GSTIN" });
  });

  it("an unknown basis value is not trusted", () => {
    const o = order({ preflight_payload: { customer_match: { customer_id: C1, basis: "made_up" } } });
    expect(customerMatchBasis({ order: o, customer: master }).basis).toBe("unverified");
  });
});

describe("the stamp the intake saves", () => {
  it("is the matcher's basis when the order's customer is the one it chose", () => {
    expect(customerMatchStamp({ autoMatch: { customer_id: C1, basis: "vendor_code" }, customerId: C1, at: "t" }))
      .toEqual({ customer_id: C1, basis: "vendor_code", at: "t" });
  });

  it("is 'operator' when a person picked another customer, or the matcher chose none", () => {
    expect(customerMatchStamp({ autoMatch: { customer_id: C1, basis: "gstin" }, customerId: "cust-2" }).basis).toBe("operator");
    expect(customerMatchStamp({ autoMatch: null, customerId: "cust-2" }).basis).toBe("operator");
  });

  it("is nothing without a customer", () => {
    expect(customerMatchStamp({ autoMatch: { customer_id: C1, basis: "gstin" }, customerId: "" })).toBeNull();
  });
});

describe("how a basis reads", () => {
  it("good when the PO backs it or a person chose it, warn otherwise", () => {
    for (const b of ["gstin", "vendor_code", "name", "letterhead", "operator"]) {
      expect(matchBasisTone(b)).toBe("good");
      expect(MATCH_BASIS_LABEL[b]).toBeTruthy();
    }
    for (const b of ["gstin_conflict", "unverified", "not_on_po", "unknown", "none"]) expect(matchBasisTone(b)).toBe("warn");
  });
});
