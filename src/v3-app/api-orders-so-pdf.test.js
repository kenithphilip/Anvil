// renderSalesOrder: the Tally-style "SALES ORDER" voucher renderer
// (reproduces the Obara P250432276 layout). Renders a realistic fixture
// and asserts a valid multi-line PDF comes back without throwing.

import { describe, it, expect } from "vitest";
import { renderSalesOrder } from "../api/_lib/pdf-renderer.js";

const fixture = {
  voucherNo: "137",
  dated: "23-Apr-25",
  modeOfPayment: "30 Days",
  buyerRef: "P250432276",
  regSerialNo: "30513",
  dispatchedThrough: "By Road",
  destination: "Maharashtra",
  termsOfDelivery: "",
  contactPerson: "Meegada Vinay Babu",
  contactPhone: "8919616793",
  message: "Please note any discrepancy within 7 days of receipt.",
  currency: "INR",
  seller: {
    name: "Northwind India Private Limited",
    addressLines: ["W-17, F-II Block, MIDC, Pimpri, Pune"],
    gstin: "27AAACO8335K1Z5", stateName: "Maharashtra", stateCode: "27",
    cin: "U31506PN2006PTC022129", email: "joe@northwind.co.in", pan: "AAACO8335K",
  },
  consignee: { name: "Hyundai Motor India Ltd -Pune", addressLines: ["Plot No A-16, MIDC Phase-II Expansion, Talegaon, Pune-410507"], gstin: "27AAACH2364M1ZF", stateName: "Maharashtra", stateCode: "27" },
  buyer: { name: "Hyundai Motor India Ltd -Pune", addressLines: ["Plot No A-16, MIDC Phase-II"], gstin: "27AAACH2364M1ZF", stateName: "Maharashtra", stateCode: "27" },
  items: [
    { sl: 1, description: "Point Holder", hsn: "85159000", custPartNo: "GD544202503040002", partNo: "403A7K188-100(O/K)", dueOn: "20-Jun-25", qty: 2, uom: "No.", rate: 27244, disc: "", amount: 54488, batch: "P250432276" },
    { sl: 2, description: "Gear Case Assy", hsn: "85159000", custPartNo: "GD544202503270028", partNo: "X168-STD(O/K)", dueOn: "20-Jun-25", qty: 2, uom: "No.", rate: 393533.7, disc: "", amount: 787067.4, batch: "P250432276" },
  ],
};

describe("renderSalesOrder (Tally SALES ORDER voucher)", () => {
  it("renders a valid PDF from a P250432276-shaped fixture", async () => {
    const buf = await renderSalesOrder(fixture);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("does not throw on empty items / missing optional fields", async () => {
    const buf = await renderSalesOrder({ seller: { name: "X" }, buyer: { name: "Y" }, items: [] });
    expect(buf.length).toBeGreaterThan(500);
  });

  it("handles many lines (multi-page) without throwing", async () => {
    const many = { ...fixture, items: Array.from({ length: 60 }, (_, i) => ({ ...fixture.items[0], sl: i + 1 })) };
    const buf = await renderSalesOrder(many);
    expect(buf.slice(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
