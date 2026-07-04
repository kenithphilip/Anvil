// Unit tests for src/api/_lib/docai/tenant-scrub.js.
//
// Anchored on the real PO that surfaced the bug: Summit Automation
// (buyer) issued a PO to OBARA (tenant). The PDF carried the
// tenant's salesperson email `benny@obara.co.in` in the "Your
// Ref" block above the line table; the extractor pulled it into
// customer.email because the buyer block had no email. The
// scrubber nulls fields that match the tenant identity.

import { describe, it, expect } from "vitest";
import {
  buildTenantIdentity,
  scrubCustomerOfTenantIdentity,
} from "../api/_lib/docai/tenant-scrub.js";

const obaraSettings = {
  einvoice_seller_legal_name: "OBARA INDIA PRIVATE LIMITED",
  einvoice_seller_gstin: "27AAACX0001A1ZA",
  einvoice_seller_email: "benny@obara.co.in",
  einvoice_seller_phone: "020-67301641",
};

describe("buildTenantIdentity", () => {
  it("derives email_domain from the seller email", () => {
    const id = buildTenantIdentity({ display_name: "OBARA" }, obaraSettings);
    expect(id.email_domain).toBe("obara.co.in");
    expect(id.gstin).toBe("27AAACX0001A1ZA");
    expect(id.legal_name).toBe("OBARA INDIA PRIVATE LIMITED");
  });

  it("falls back to tenants.display_name when seller legal_name is unset", () => {
    const id = buildTenantIdentity({ display_name: "OBARA INDIA" }, {
      einvoice_seller_email: "x@y.com",
    });
    expect(id.legal_name).toBe("OBARA INDIA");
  });

  it("returns null when no identity fields are available", () => {
    expect(buildTenantIdentity(null, null)).toBeNull();
    expect(buildTenantIdentity({}, {})).toBeNull();
  });

  it("captures alias emails + phones from docai_tenant_aliases", () => {
    const id = buildTenantIdentity({ display_name: "OBARA" }, {
      einvoice_seller_email: "benny@obara.co.in",
      docai_tenant_aliases: {
        emails: ["sales@obara.co.in", "support@obara.co.in"],
        phones: ["+91-20-67301641", "+91-9876543210"],
      },
    });
    expect(id.alias_emails).toContain("sales@obara.co.in");
    expect(id.alias_emails).toContain("support@obara.co.in");
    expect(id.alias_phones.length).toBe(2);
  });
});

describe("scrubCustomerOfTenantIdentity (the Summit PO bug)", () => {
  const identity = buildTenantIdentity({ display_name: "OBARA INDIA" }, obaraSettings);

  it("nulls customer.email when it matches the tenant email exactly", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "Summit Automation Systems & Tooling Pvt. Ltd.",
      gstin: "27AACCF1990R1ZZ",
      email: "benny@obara.co.in",
      phone: "020-65412121",
    }, identity);
    expect(customer.email).toBeNull();
    expect(customer.name).toBe("Summit Automation Systems & Tooling Pvt. Ltd.");
    expect(customer.gstin).toBe("27AACCF1990R1ZZ");
    expect(scrubbed).toEqual(["email"]);
  });

  it("nulls customer.email when only the domain matches (other tenant employees)", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "Summit Automation Pvt Ltd",
      email: "anyone-else@obara.co.in",
    }, identity);
    expect(customer.email).toBeNull();
    expect(scrubbed).toContain("email");
  });

  it("keeps a customer email when neither value nor domain matches the tenant", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "Summit Automation Pvt Ltd",
      email: "procurement@faithautomation.com",
    }, identity);
    expect(customer.email).toBe("procurement@faithautomation.com");
    expect(scrubbed).toEqual([]);
  });

  it("nulls customer.phone when last 10 digits match the tenant phone", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "Summit Automation Pvt Ltd",
      phone: "+91-20-67301641",
    }, identity);
    expect(customer.phone).toBeNull();
    expect(scrubbed).toContain("phone");
  });

  it("hard-nulls customer.gstin when it matches the tenant GSTIN", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "Some buyer",
      gstin: "27AAACX0001A1ZA",
    }, identity);
    expect(customer.gstin).toBeNull();
    expect(scrubbed).toContain("gstin");
  });

  it("nulls customer.name when it matches the tenant legal name", () => {
    const { customer, scrubbed } = scrubCustomerOfTenantIdentity({
      name: "OBARA India Pvt Ltd",
      gstin: "27AACCF1990R1ZZ",
    }, identity);
    expect(customer.name).toBeNull();
    expect(scrubbed).toContain("name");
  });

  it("leaves the customer untouched when identity is null", () => {
    const cust = { name: "Summit", email: "x@y.com" };
    const r = scrubCustomerOfTenantIdentity(cust, null);
    expect(r.customer).toBe(cust);
    expect(r.scrubbed).toEqual([]);
  });
});
