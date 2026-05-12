// Unit tests for src/api/_lib/tally-voucher-type.js.
//
// Confirms the canonical -> XML name mapping and the per-company
// resolver behave as the Phase 1 F1 audit prescribes. The default
// is "Sales" (accounting voucher) so the SO push books GST output
// and revenue. "SalesOrder" is the tracker variant and only used
// when the tenant has explicitly opted in.

import { describe, it, expect } from "vitest";
import {
  toTallyXmlName,
  isCanonicalVoucherType,
  resolveSalesVoucherType,
  DEFAULT_CANONICAL_VOUCHER_TYPE,
} from "../api/_lib/tally-voucher-type.js";
import { __buildTallyAmendXmlForTests as buildAmendXml } from "../api/tally/amend.js";

describe("tally-voucher-type / toTallyXmlName", () => {
  it("maps Sales to the Tally XML literal", () => {
    expect(toTallyXmlName("Sales")).toBe("Sales");
  });
  it("maps SalesOrder to the spaced Tally literal", () => {
    expect(toTallyXmlName("SalesOrder")).toBe("Sales Order");
  });
  it("maps DebitNote / CreditNote / StockJournal to the spaced literal", () => {
    expect(toTallyXmlName("DebitNote")).toBe("Debit Note");
    expect(toTallyXmlName("CreditNote")).toBe("Credit Note");
    expect(toTallyXmlName("StockJournal")).toBe("Stock Journal");
  });
  it("falls back to the audited safe default on unknown input", () => {
    expect(toTallyXmlName("Garbage")).toBe("Sales");
    expect(toTallyXmlName(null)).toBe("Sales");
    expect(toTallyXmlName(undefined)).toBe("Sales");
    expect(toTallyXmlName("")).toBe("Sales");
  });
  it("DEFAULT_CANONICAL_VOUCHER_TYPE is Sales", () => {
    expect(DEFAULT_CANONICAL_VOUCHER_TYPE).toBe("Sales");
  });
});

describe("tally-voucher-type / isCanonicalVoucherType", () => {
  it("accepts known canonical names", () => {
    ["Sales", "SalesOrder", "Purchase", "Receipt", "Payment", "Contra",
     "Journal", "DebitNote", "CreditNote", "StockJournal"]
      .forEach((s) => expect(isCanonicalVoucherType(s)).toBe(true));
  });
  it("rejects spaced or unknown values", () => {
    expect(isCanonicalVoucherType("Sales Order")).toBe(false);
    expect(isCanonicalVoucherType("Invoice")).toBe(false);
    expect(isCanonicalVoucherType(null)).toBe(false);
    expect(isCanonicalVoucherType(123)).toBe(false);
    expect(isCanonicalVoucherType("")).toBe(false);
  });
});

describe("tally-voucher-type / resolveSalesVoucherType", () => {
  it("returns the company override when set and valid", () => {
    expect(resolveSalesVoucherType({ default_sales_voucher_type: "SalesOrder" }))
      .toBe("SalesOrder");
  });
  it("returns Sales when company override is unset", () => {
    expect(resolveSalesVoucherType({})).toBe("Sales");
    expect(resolveSalesVoucherType(null)).toBe("Sales");
    expect(resolveSalesVoucherType(undefined)).toBe("Sales");
  });
  it("returns Sales when company override is an unknown value", () => {
    expect(resolveSalesVoucherType({ default_sales_voucher_type: "Invoice" }))
      .toBe("Sales");
    expect(resolveSalesVoucherType({ default_sales_voucher_type: "Sales Order" }))
      .toBe("Sales");
  });
});

describe("amend.js / buildTallyAmendXml integration", () => {
  const sample = {
    voucherNo: "SO-440",
    date: "2026-05-10",
    partyName: "Acme Pvt Ltd",
    lineItems: [{ itemName: "BR-6204-ZZ", rate: 1000, amount: 5000, qty: 5 }],
  };
  it("emits VCHTYPE=Sales by default", () => {
    const xml = buildAmendXml(sample, null, "Sales");
    expect(xml).toContain('VCHTYPE="Sales"');
    expect(xml).toContain("<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>");
    expect(xml).not.toContain('VCHTYPE="Sales Order"');
  });
  it("emits VCHTYPE=Sales Order when explicitly configured", () => {
    const xml = buildAmendXml(sample, null, "Sales Order");
    expect(xml).toContain('VCHTYPE="Sales Order"');
    expect(xml).toContain("<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>");
  });
  it("XML-escapes a malformed voucher type rather than emitting raw markup", () => {
    const xml = buildAmendXml(sample, null, '"><script>x</script>');
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&quot;&gt;&lt;script&gt;");
  });
});
