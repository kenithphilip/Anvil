// Issue #186 P1: create a customer from a GSTIN. The structural half (state
// code / PAN / validity) is derived with NO API and always returned; the
// registry half is provider-gated (default-deny).

import { describe, it, expect } from "vitest";
import { deriveGstinFields, classifyExisting } from "../api/customers/gst_lookup.js";
import { normalizeRegistry, lookupGstinRegistry } from "../api/_lib/gst-provider.js";
import { findCustomersByPan } from "../api/_lib/customer-canonicalizer.js";
import { gstinChecksumChar } from "../api/_lib/gstin.js";

const HEAD = "29ABCDE1234F1Z";            // state 29 (Karnataka) + PAN ABCDE1234F + entity + Z
const VALID = HEAD + gstinChecksumChar(HEAD);

describe("deriveGstinFields", () => {
  it("a valid GSTIN yields state + PAN + all verification ticks (no API)", () => {
    const r = deriveGstinFields(VALID.toLowerCase());   // case-insensitive
    expect(r).toMatchObject({ gstin: VALID, valid: true, state_code: "29", pan: "ABCDE1234F", validation_message: null });
    expect(r.verification).toEqual({ format: true, state: true, checksum: true });
    expect(r.state_name).toBeTruthy();                  // Karnataka
  });

  it("a wrong-checksum GSTIN still surfaces state + PAN (format+state pass)", () => {
    const cs = gstinChecksumChar(HEAD);
    const bad = HEAD + (cs === "Z" ? "A" : "Z");         // valid shape/state, wrong checksum
    const r = deriveGstinFields(bad);
    expect(r.valid).toBe(false);
    expect(r.verification).toEqual({ format: true, state: true, checksum: false });
    expect(r.state_code).toBe("29");
    expect(r.pan).toBe("ABCDE1234F");
  });

  it("an unlisted state fails the state check but keeps the code", () => {
    const r = deriveGstinFields("00ABCDE1234F1ZZ");      // well-formed, state 00 not on the schedule
    expect(r.verification).toMatchObject({ format: true, state: false });
    expect(r.state_code).toBe("00");
    expect(r.state_name).toBeNull();
  });

  it("a malformed GSTIN fails format with no state/PAN", () => {
    const r = deriveGstinFields("NOT-A-GSTIN");
    expect(r.valid).toBe(false);
    expect(r.verification.format).toBe(false);
    expect(r.state_code).toBeNull();
    expect(r.pan).toBeNull();
  });
});

describe("gst-provider", () => {
  it("normalizeRegistry maps the common Indian-wrapper field names", () => {
    const n = normalizeRegistry({ lgnm: "ACME STEELS PVT LTD", tradeNam: "ACME", pradr: { adr: "12 MG Road, Bengaluru" }, sts: "Active", dty: "Regular", rgdt: "01/07/2017" });
    expect(n).toMatchObject({ legal_name: "ACME STEELS PVT LTD", trade_name: "ACME", address: "12 MG Road, Bengaluru", status: "Active", taxpayer_type: "Regular", registration_date: "01/07/2017" });
  });

  it("default-denies the registry when no provider is configured", async () => {
    expect(await lookupGstinRegistry(VALID, {})).toMatchObject({ ok: false, reason: "not_configured" });
    expect(await lookupGstinRegistry(VALID, { gst_provider: "none" })).toMatchObject({ ok: false, reason: "not_configured" });
    // a named provider without creds is still not configured
    expect(await lookupGstinRegistry(VALID, { gst_provider: "masters_india" })).toMatchObject({ ok: false, reason: "not_configured" });
  });
});

describe("dedup by GSTIN / PAN (P2)", () => {
  it("classifyExisting flags an exact GSTIN duplicate vs a same-PAN branch", () => {
    const rows = [
      { id: "c1", customer_name: "ACME Karnataka", gstin: VALID, state_code: "29" },
      { id: "c2", customer_name: "ACME Maharashtra", gstin: "27ABCDE1234F1ZX", state_code: "27" }, // same PAN, MH
    ];
    const out = classifyExisting(rows, VALID);
    expect(out[0].match).toBe("gstin");   // exact
    expect(out[1].match).toBe("pan");     // same entity, other state
    expect(out[1]).toMatchObject({ customer_name: "ACME Maharashtra", state_code: "27" });
  });

  it("findCustomersByPan queries the PAN slot and needs a 10-char PAN", async () => {
    let pattern = null;
    const svc = { from: () => { const b = { select: () => b, eq: () => b, ilike: (_c, p) => { pattern = p; return b; }, limit: () => b, then: (fn) => Promise.resolve(fn({ data: [{ id: "c1", gstin: VALID }], error: null })) }; return b; } };
    const rows = await findCustomersByPan(svc, "t1", "ABCDE1234F");
    expect(pattern).toBe("__ABCDE1234F%");             // 2 state chars, PAN, then the rest
    expect(rows).toHaveLength(1);
    expect(await findCustomersByPan(svc, "t1", "SHORT")).toEqual([]); // not a 10-char PAN -> no query
  });
});
