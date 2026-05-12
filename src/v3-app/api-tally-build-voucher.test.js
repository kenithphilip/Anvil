// Unit tests for src/api/_lib/tally-build-voucher.js (Phase 1 F1
// second half). Confirms:
//
//   - Intrastate (seller-MH + buyer-MH) emits CGST + SGST, not IGST.
//   - Interstate (seller-MH + buyer-KA) emits IGST, not CGST/SGST.
//   - Unknown buyer state falls back to interstate (conservative
//     default; intrastate misclassification leaks tax revenue).
//   - Line totals sum correctly and party DR amount is negative.
//   - VCHTYPE follows tally_companies.default_sales_voucher_type
//     (the F1 first-half work).
//   - Placeholder envelope detection.

import { describe, it, expect } from "vitest";
import {
  buildSalesVoucherXml,
  computeLineTax,
  placeOfSupplyKind,
  sellerStateCode,
  buyerStateCode,
  isPlaceholderXml,
} from "../api/_lib/tally-build-voucher.js";

const sellerMH = {
  id: "co-1",
  name: "Anvil Test Co",
  gstin: "27AAPFU0939F1ZV",
  state_code: "27",
  default_sales_ledger: "Sales 18%",
  default_sales_voucher_type: "Sales",
};

const buyerMH = {
  id: "cust-1",
  customer_name: "Mumbai Customer Pvt Ltd",
  gstin: "27AAACR4849R1ZD",
  state_code: "27",
};

const buyerKA = {
  id: "cust-2",
  customer_name: "Karnataka Customer",
  gstin: "29AAACR4849R1Z2",
  state_code: "29",
};

const orderFixture = {
  id: "ord-1",
  po_number: "PO-9001",
  po_date: "2026-05-10",
  customer_id: "cust-1",
  result: {
    salesOrder: {
      lineItems: [
        { description: "Bearing", itemCode: "BR-6204", qty: 10, rate: 1000, uom: "Nos", gst_pct: 18 },
        { description: "Seal kit", itemCode: "SK-100", qty: 5, rate: 500, uom: "Nos", gst_pct: 18 },
      ],
    },
  },
};

describe("placeOfSupplyKind", () => {
  it("intrastate when seller and buyer states match", () => {
    expect(placeOfSupplyKind(sellerMH, buyerMH)).toBe("intrastate");
  });
  it("interstate when states differ", () => {
    expect(placeOfSupplyKind(sellerMH, buyerKA)).toBe("interstate");
  });
  it("falls back to interstate when buyer state is unknown", () => {
    expect(placeOfSupplyKind(sellerMH, { customer_name: "Mystery", gstin: "", state_code: "" })).toBe("interstate");
  });
  it("falls back to interstate when seller state is unknown", () => {
    expect(placeOfSupplyKind({ name: "x", gstin: "" }, buyerMH)).toBe("interstate");
  });
});

describe("sellerStateCode / buyerStateCode", () => {
  it("prefers explicit state_code", () => {
    expect(sellerStateCode({ state_code: "27" })).toBe("27");
    expect(buyerStateCode({ state_code: "29" })).toBe("29");
  });
  it("falls back to GSTIN prefix", () => {
    expect(sellerStateCode({ gstin: "27AAPFU0939F1ZV" })).toBe("27");
    expect(buyerStateCode({ gstin: "29AAACR4849R1Z2" })).toBe("29");
  });
});

describe("computeLineTax", () => {
  it("splits GST 50/50 into CGST + SGST for intrastate", () => {
    const r = computeLineTax({ qty: 10, rate: 1000, gst_pct: 18 }, "intrastate");
    expect(r.taxable).toBe(10000);
    expect(r.cgst).toBe(900);
    expect(r.sgst).toBe(900);
    expect(r.igst).toBe(0);
    expect(r.line_total).toBe(11800);
  });
  it("puts the full GST into IGST for interstate", () => {
    const r = computeLineTax({ qty: 10, rate: 1000, gst_pct: 18 }, "interstate");
    expect(r.taxable).toBe(10000);
    expect(r.igst).toBe(1800);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
  });
  it("accepts the quantity / unitPrice aliases", () => {
    const r = computeLineTax({ quantity: 5, unitPrice: 200, gst_pct: 12 }, "intrastate");
    expect(r.taxable).toBe(1000);
    expect(r.cgst).toBe(60);
    expect(r.sgst).toBe(60);
  });
  it("includes CESS when cess_pct is set", () => {
    const r = computeLineTax({ qty: 1, rate: 1000, gst_pct: 28, cess_pct: 1 }, "interstate");
    expect(r.cess).toBe(10);
  });
});

describe("buildSalesVoucherXml", () => {
  it("emits CGST + SGST ledgers for intrastate", () => {
    const { xml, metadata } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: buyerMH,
      voucherNo: "SO-PO-9001",
    });
    expect(metadata.kind).toBe("intrastate");
    expect(xml).toContain("CGST Output 18%");
    expect(xml).toContain("SGST Output 18%");
    expect(xml).not.toContain("IGST Output");
    expect(metadata.taxes.cgst).toBeGreaterThan(0);
    expect(metadata.taxes.sgst).toBeGreaterThan(0);
    expect(metadata.taxes.igst).toBe(0);
  });

  it("emits IGST ledger for interstate", () => {
    const { xml, metadata } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: buyerKA,
      voucherNo: "SO-PO-9002",
    });
    expect(metadata.kind).toBe("interstate");
    expect(xml).toContain("IGST Output 18%");
    expect(xml).not.toContain("CGST Output");
    expect(xml).not.toContain("SGST Output");
    expect(metadata.taxes.igst).toBeGreaterThan(0);
    expect(metadata.taxes.cgst).toBe(0);
  });

  it("uses VCHTYPE=Sales by default and reflects per-company override", () => {
    const a = buildSalesVoucherXml({ order: orderFixture, company: sellerMH, customer: buyerMH });
    expect(a.xml).toContain('VCHTYPE="Sales"');
    expect(a.xml).toContain("<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>");

    const b = buildSalesVoucherXml({
      order: orderFixture,
      company: { ...sellerMH, default_sales_voucher_type: "SalesOrder" },
      customer: buyerMH,
    });
    expect(b.xml).toContain('VCHTYPE="Sales Order"');
  });

  it("emits the party DR with a negative amount equal to the grand total", () => {
    const { xml, metadata } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: buyerMH,
    });
    expect(metadata.grand_total).toBeGreaterThan(0);
    expect(xml).toContain("<LEDGERNAME>Mumbai Customer Pvt Ltd</LEDGERNAME>");
    expect(xml).toContain("<AMOUNT>-" + metadata.grand_total + "</AMOUNT>");
  });

  it("includes a STOCKITEMNAME and ACCOUNTINGALLOCATIONS line per inventory entry", () => {
    const { xml } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: buyerMH,
    });
    expect((xml.match(/<ALLINVENTORYENTRIES.LIST>/g) || []).length).toBe(2);
    expect(xml).toContain("<STOCKITEMNAME>Bearing</STOCKITEMNAME>");
    expect(xml).toContain("<STOCKITEMNAME>Seal kit</STOCKITEMNAME>");
    expect((xml.match(/<ACCOUNTINGALLOCATIONS.LIST>/g) || []).length).toBe(2);
  });

  it("XML-escapes party name with quotes / ampersands", () => {
    const { xml } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: { ...buyerMH, customer_name: 'M & N "Bearings"' },
    });
    expect(xml).toContain("M &amp; N &quot;Bearings&quot;");
    expect(xml).not.toContain("M & N \"Bearings\"");
  });

  it("falls back to interstate when buyer state is missing (safer default)", () => {
    const noStateBuyer = { customer_name: "Mystery", gstin: "", state_code: "" };
    const { xml, metadata } = buildSalesVoucherXml({
      order: orderFixture,
      company: sellerMH,
      customer: noStateBuyer,
    });
    expect(metadata.kind).toBe("interstate");
    expect(xml).toContain("IGST Output");
  });
});

describe("isPlaceholderXml", () => {
  it("returns true for <ENVELOPE/> and <envelope></envelope>", () => {
    expect(isPlaceholderXml("<ENVELOPE/>")).toBe(true);
    expect(isPlaceholderXml("<envelope></envelope>")).toBe(true);
    expect(isPlaceholderXml("   <ENVELOPE/>  ")).toBe(true);
  });
  it("returns true for empty / null", () => {
    expect(isPlaceholderXml(null)).toBe(true);
    expect(isPlaceholderXml(undefined)).toBe(true);
    expect(isPlaceholderXml("")).toBe(true);
  });
  it("returns false for a real envelope", () => {
    expect(isPlaceholderXml("<ENVELOPE><HEADER/></ENVELOPE>")).toBe(false);
  });
});
