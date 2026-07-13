// Unit tests for the e-invoice payload composer — the CGST/SGST/IGST split is
// now COMPUTED from place of supply + line gst_pct (was reading never-written
// fields -> all zeros). Also covers cess and SupTyp derivation.

import { describe, it, expect } from "vitest";
import { composePayload } from "../api/einvoice/index.js";

const seller = { Gstin: "27AAAAA0000A1Z5", LglNm: "Seller Co", Stcd: "27" };
const orderWith = (lines) => ({
  id: "ord-123", po_number: "PO-9", created_at: "2026-06-06T00:00:00Z",
  result: { salesOrder: { lineItems: lines } },
});
const line = { itemName: "Bearing", hsn: "8482", qty: 5, rate: 11436, amount: 57180, gst_pct: 18 };

describe("composePayload — tax split", () => {
  it("intra-state supply splits into CGST + SGST (not empty)", () => {
    const cust = { customer_name: "Buyer", gstin: "27BBBBB0000B1Z5", state_code: "27", country: "IN" };
    const p = composePayload(orderWith([line]), cust, seller);
    const it0 = p.ItemList[0];
    expect(it0.CgstAmt).toBe(5146.2);   // 18% of 57180 / 2
    expect(it0.SgstAmt).toBe(5146.2);
    expect(it0.IgstAmt).toBe(0);
    expect(it0.GstRt).toBe(18);
    expect(p.ValDtls.AssVal).toBe(57180);
    expect(p.ValDtls.CgstVal).toBe(5146.2);
    expect(p.ValDtls.SgstVal).toBe(5146.2);
    expect(p.ValDtls.IgstVal).toBe(0);
    expect(p.ValDtls.TotInvVal).toBe(67472.4);
    expect(p.TranDtls.SupTyp).toBe("B2B");
  });

  it("inter-state supply puts the full rate into IGST", () => {
    const cust = { customer_name: "Buyer", gstin: "29BBBBB0000B1Z5", state_code: "29", country: "IN" };
    const p = composePayload(orderWith([line]), cust, seller);
    expect(p.ItemList[0].IgstAmt).toBe(10292.4);
    expect(p.ItemList[0].CgstAmt).toBe(0);
    expect(p.ValDtls.IgstVal).toBe(10292.4);
    expect(p.ValDtls.TotInvVal).toBe(67472.4);
  });

  it("includes cess in the line + totals", () => {
    const cust = { state_code: "27", country: "IN" };
    const p = composePayload(orderWith([{ ...line, cess_pct: 1 }]), cust, seller);
    expect(p.ItemList[0].CesAmt).toBe(571.8);   // 1% of 57180
    expect(p.ValDtls.CesVal).toBe(571.8);
    expect(p.ValDtls.TotInvVal).toBe(68044.2);  // 57180 + 10292.4 + 571.8
  });

  it("derives export SupTyp for a foreign buyer instead of hardcoding B2B", () => {
    const zeroRated = { ...line, gst_pct: 0 };
    const foreign = { customer_name: "US Corp", country: "US", state_code: null };
    expect(composePayload(orderWith([zeroRated]), foreign, seller).TranDtls.SupTyp).toBe("EXPWOP");
    // Foreign + IGST charged -> export with payment.
    expect(composePayload(orderWith([line]), foreign, seller).TranDtls.SupTyp).toBe("EXPWP");
  });

  it("honours an explicit reverse-charge flag", () => {
    const order = orderWith([line]);
    order.result.salesOrder.reverse_charge = true;
    const p = composePayload(order, { state_code: "27", country: "IN" }, seller);
    expect(p.TranDtls.RegRev).toBe("Y");
  });
});
