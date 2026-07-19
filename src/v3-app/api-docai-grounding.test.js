// Unit tests for the extraction grounding verifier (Phase 1: GSTIN -> customer
// identity pin). Pure logic — the caller does validateGstin()/findByGstin() and
// passes the results in.

import { describe, it, expect } from "vitest";
import { computeGstinPin, nameConflicts } from "../api/_lib/docai/grounding.js";

const VALID = { ok: true, normalized: "27AAACA1234B1Z5" };

describe("nameConflicts", () => {
  it("does not conflict on legal-form / abbreviation variants", () => {
    expect(nameConflicts("ACME Pvt Ltd", "Acme Private Limited")).toBe(false);
    expect(nameConflicts("Acme", "Acme Steels")).toBe(false);
  });
  it("conflicts when names share no significant token", () => {
    expect(nameConflicts("Acme Industries", "Globex Corporation")).toBe(true);
  });
  it("does not conflict when either side is empty (GSTIN is the key)", () => {
    expect(nameConflicts("", "Acme")).toBe(false);
    expect(nameConflicts("Acme", "")).toBe(false);
  });
});

describe("computeGstinPin", () => {
  it("caps confidence + flags on an invalid checksum, no registry lookup used", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: "27BADGSTIN0000Z9", name: "Acme" },
      matchedCustomer: null,
      gstinValidation: { ok: false, code: "checksum" },
      stateFromGstin: null,
    });
    expect(r.confidenceCaps["customer.gstin"]).toBe(0.3);
    expect(r.flags.map((f) => f.code)).toContain("gstin_invalid");
    expect(r.matched_customer_id).toBeNull();
    expect(r.patch).toEqual({});
  });

  it("treats a whitespace-only field as blank and fills it (caller applies patch directly)", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: VALID.normalized, name: "   ", state_code: " " },
      matchedCustomer: { id: "c-9", customer_name: "Acme Steels", state_code: "27" },
      gstinValidation: VALID,
      stateFromGstin: "27",
    });
    // grounding treats "   " as blank -> patches it; the run.js caller applies
    // pin.patch directly, so the whitespace value never survives with a high
    // confidence floor stamped on it.
    expect(r.patch.name).toBe("Acme Steels");
    expect(r.patch.state_code).toBe("27");
  });

  it("flags a valid-but-unknown GSTIN and still derives state_code", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: VALID.normalized, name: "New Buyer", state_code: "" },
      matchedCustomer: null,
      gstinValidation: VALID,
      stateFromGstin: "27",
    });
    expect(r.flags.map((f) => f.code)).toContain("gstin_valid_unknown_customer");
    expect(r.patch.state_code).toBe("27");
    expect(r.confidenceFloors["customer.state_code"]).toBe(0.98);
    expect(r.matched_customer_id).toBeNull();
  });

  it("pins a blank name from the registry match and corroborates the GSTIN", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: VALID.normalized, name: "", state_code: "", payment_terms: "" },
      matchedCustomer: { id: "c-1", customer_name: "Acme Steels", state_code: "27", default_payment_terms: "Net 30" },
      gstinValidation: VALID,
      stateFromGstin: "27",
    });
    expect(r.matched_customer_id).toBe("c-1");
    expect(r.patch.name).toBe("Acme Steels");
    expect(r.patch.payment_terms).toBe("Net 30");
    expect(r.patch.state_code).toBe("27");
    expect(r.confidenceFloors["customer.gstin"]).toBe(0.98);
    expect(r.confidenceFloors["customer.name"]).toBe(0.9);
    expect(r.flags).toEqual([]);
  });

  it("flags a name/GSTIN mismatch WITHOUT overwriting the extracted name", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: VALID.normalized, name: "Globex Corporation" },
      matchedCustomer: { id: "c-2", customer_name: "Acme Steels" },
      gstinValidation: VALID,
      stateFromGstin: "27",
    });
    expect(r.matched_customer_id).toBe("c-2");
    expect(r.patch.name).toBeUndefined();           // never clobbered
    expect(r.flags.map((f) => f.code)).toContain("customer_name_gstin_mismatch");
    expect(r.confidenceFloors["customer.gstin"]).toBe(0.98);
  });

  it("never overwrites non-blank extracted fields (fill-blanks-only)", () => {
    const r = computeGstinPin({
      extractedCustomer: { gstin: VALID.normalized, name: "Acme Steels", state_code: "29", payment_terms: "Advance" },
      matchedCustomer: { id: "c-3", customer_name: "Acme Steels", state_code: "27", default_payment_terms: "Net 30" },
      gstinValidation: VALID,
      stateFromGstin: "27",
    });
    expect(r.patch).toEqual({});                     // all fields already present
    expect(r.confidenceFloors["customer.gstin"]).toBe(0.98);
  });
});
