// Per-customer order-header defaults (streamline inputs): resolve from the
// existing masters and fill only absent fields so explicit/OCR values win.

import { describe, it, expect } from "vitest";
import { resolveCustomerDefaults, applyCustomerDefaults, CUSTOMER_DEFAULT_HEADER_KEYS } from "../api/_lib/customer-defaults.js";

// Minimal fake svc supporting the chained shapes the helper uses:
// .select().eq()...maybeSingle() (customers) and .select().eq()...order()/.limit()
// then awaited (vendor codes / contacts).
const makeSvc = (data) => ({
  from(table) {
    const rows = data[table] || [];
    const q = {
      select() { return q; },
      eq() { return q; },
      order() { return q; },
      limit() { return q; },
      maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
    };
    return q;
  },
});

describe("resolveCustomerDefaults", () => {
  it("pulls incoterm, vendor code (primary), delivery contact + country from masters", async () => {
    const svc = makeSvc({
      customers: [{ country: "IN", default_incoterms: "FOB" }],
      customer_vendor_codes: [{ vendor_code: "TH1M", is_primary: true }],
      customer_contacts: [{ id: "c-1", is_primary: true }],
    });
    const out = await resolveCustomerDefaults(svc, "t-1", "cust-1");
    expect(out).toMatchObject({ country: "IN", incoterm_code: "FOB", vendor_code: "TH1M", delivery_point_contact_id: "c-1" });
  });
  it("returns {} when no customerId", async () => {
    expect(await resolveCustomerDefaults(makeSvc({}), "t-1", null)).toEqual({});
  });
  it("tolerates masters with no defaults (best-effort)", async () => {
    const out = await resolveCustomerDefaults(makeSvc({ customers: [{}] }), "t-1", "c");
    expect(out).toEqual({});
  });
});

describe("applyCustomerDefaults", () => {
  it("fills only absent fields — an explicit/OCR value is never overwritten", () => {
    const body = { incoterm_code: "CIF" }; // e.g. detected from the PO
    const filled = applyCustomerDefaults(body, { incoterm_code: "FOB", vendor_code: "TH1M", country: "IN" });
    expect(body.incoterm_code).toBe("CIF");        // kept
    expect(body.vendor_code).toBe("TH1M");          // filled
    expect(body.country).toBe("IN");
    expect(filled).toContain("vendor_code");
    expect(filled).not.toContain("incoterm_code");
  });
  it("reports the filled header keys (for provenance stamping)", () => {
    const body = {};
    const filled = applyCustomerDefaults(body, { vendor_code: "TH1M", delivery_point_contact_id: "c-1" });
    const hdr = filled.filter((k) => CUSTOMER_DEFAULT_HEADER_KEYS.includes(k));
    expect(hdr.sort()).toEqual(["delivery_point_contact_id", "vendor_code"]);
  });
  it("ignores blank-string defaults", () => {
    const body = {};
    applyCustomerDefaults(body, { vendor_code: "" });
    expect(body.vendor_code).toBeUndefined();
  });
});
