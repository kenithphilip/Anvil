// GRN payment statement.
//
// THE CONSTRAINT that shapes everything: the customer processes the PO
// carefully and then goes quiet, so the GRN — number + date — is OFTEN NEVER
// SENT. Since Indian B2B terms routinely clock off the GRN date ("30 days from
// date of receipt"), a missing GRN means the due date is genuinely UNKNOWN, not
// late. So the statement must degrade gracefully AND turn itself into the nudge
// that gets the GRN sent. These tests assert exactly that.

import { describe, it, expect } from "vitest";
import {
  parsePaymentTerms, computeInvoiceLine, buildPaymentStatement, renderStatementText,
} from "../api/_lib/payment-statement.js";

describe("parsePaymentTerms", () => {
  it("reads receipt-based terms (the Mahindra shape)", () => {
    expect(parsePaymentTerms("D004-30 days from date of receipt")).toMatchObject({ days: 30, basis: "receipt" });
  });
  it("reads invoice-based and bare-days terms", () => {
    expect(parsePaymentTerms("45 days from invoice date")).toMatchObject({ days: 45, basis: "invoice" });
    expect(parsePaymentTerms("Net 60")).toMatchObject({ days: 60, basis: "invoice" });
    expect(parsePaymentTerms("30 days")).toMatchObject({ days: 30, basis: "invoice" });
  });
  it("treats GRN / delivery wording as receipt-based", () => {
    expect(parsePaymentTerms("30 days from GRN").basis).toBe("receipt");
    expect(parsePaymentTerms("15 days from delivery").basis).toBe("receipt");
  });
  it("returns unknown when no day count is present", () => {
    expect(parsePaymentTerms("Against delivery")).toMatchObject({ days: null, basis: "unknown" });
  });
});

const INV = {
  id: "i1", invoice_number: "INV-1", po_number: "PO-1", issue_date: "2026-01-01",
  currency: "INR", grand_total: 100000, paid_amount: 0, payment_terms: "30 days from date of receipt",
};

describe("computeInvoiceLine / the GRN-missing cases", () => {
  it("with a GRN, the due date clocks off the GRN date (per contract)", () => {
    const line = computeInvoiceLine(INV, { receipt_number: "GRN-9", receipt_date: "2026-02-10" }, "2026-03-01");
    expect(line.due_basis).toBe("grn");
    expect(line.due_date).toBe("2026-03-12");           // 2026-02-10 + 30
    expect(line.grn_awaited).toBe(false);
  });

  it("WITHOUT a GRN on receipt-based terms: due date is PROVISIONAL and flagged", () => {
    const line = computeInvoiceLine(INV, null, "2026-03-01");
    expect(line.grn_awaited).toBe(true);                 // the nudge flag
    expect(line.due_basis).toBe("provisional");
    expect(line.due_date).toBe("2026-01-31");            // invoice + 30, as a placeholder
    // A provisional figure is NOT dunned as overdue — the clock has not started.
    expect(line.overdue).toBe(false);
  });

  it("invoice-based terms compute a real due date with no GRN needed", () => {
    const line = computeInvoiceLine({ ...INV, payment_terms: "Net 45" }, null, "2026-03-01");
    expect(line.due_basis).toBe("invoice");
    expect(line.due_date).toBe("2026-02-15");
    expect(line.overdue).toBe(true);                     // 2026-02-15 < 2026-03-01
    expect(line.days_past_due).toBe(14);
  });

  it("unparseable terms fall back to the invoice's stored due_date", () => {
    const line = computeInvoiceLine({ ...INV, payment_terms: "Against delivery", due_date: "2026-02-01" }, null, "2026-03-01");
    expect(line.due_basis).toBe("invoice");
    expect(line.due_date).toBe("2026-02-01");
  });

  it("outstanding is grand_total minus paid", () => {
    expect(computeInvoiceLine({ ...INV, paid_amount: 40000 }, null, "2026-03-01").outstanding).toBe(60000);
  });
});

describe("buildPaymentStatement", () => {
  const customer = { id: "c1", customer_name: "MAHINDRA & MAHINDRA LTD" };

  it("matches a receipt to its invoice by invoice_id, then number, then PO", () => {
    const invoices = [
      { ...INV, id: "i1", invoice_number: "INV-1", po_number: "PO-1" },
      { id: "i2", invoice_number: "INV-2", po_number: "PO-2", issue_date: "2026-01-05", grand_total: 50000, paid_amount: 0, payment_terms: "30 days from receipt" },
      { id: "i3", invoice_number: "INV-3", po_number: "PO-3", issue_date: "2026-01-06", grand_total: 25000, paid_amount: 0, payment_terms: "30 days from receipt" },
    ];
    const receipts = [
      { invoice_id: "i1", receipt_number: "G1", receipt_date: "2026-02-01" },
      { invoice_number: "INV-2", receipt_number: "G2", receipt_date: "2026-02-02" },
      { po_number: "PO-3", receipt_number: "G3", receipt_date: "2026-02-03" },
    ];
    const st = buildPaymentStatement({ customer, invoices, receipts, today: "2026-03-01" });
    expect(st.lines.map((l) => l.grn_number)).toEqual(["G1", "G2", "G3"]);
    expect(st.summary.grn_awaited_count).toBe(0);
  });

  it("summary isolates how much is stuck ONLY because the GRN is missing", () => {
    const invoices = [
      { ...INV, id: "i1", grand_total: 100000 },                                        // GRN awaited
      { id: "i2", invoice_number: "INV-2", issue_date: "2026-01-05", grand_total: 40000, paid_amount: 0, payment_terms: "Net 45" }, // invoice terms
    ];
    const st = buildPaymentStatement({ customer, invoices, receipts: [], today: "2026-03-01" });
    expect(st.summary.total_outstanding).toBe(140000);
    expect(st.summary.grn_awaited_count).toBe(1);
    expect(st.summary.grn_awaited_outstanding).toBe(100000);
    // The GRN-awaited amount sits in its own aging bucket, not "overdue".
    const awaited = st.aging.find((b) => b.label === "grn_awaited");
    expect(awaited.outstanding).toBe(100000);
  });

  it("excludes fully paid invoices", () => {
    const st = buildPaymentStatement({
      customer,
      invoices: [{ ...INV, paid_amount: 100000 }],
      receipts: [], today: "2026-03-01",
    });
    expect(st.lines).toHaveLength(0);
    expect(st.summary.total_outstanding).toBe(0);
  });
});

describe("renderStatementText doubles as a GRN nudge", () => {
  it("asks for the GRN when any line is awaiting one", () => {
    const st = buildPaymentStatement({
      customer: { id: "c1", customer_name: "Acme" },
      invoices: [INV], receipts: [], today: "2026-03-01",
    });
    const body = renderStatementText(st);
    expect(body).toMatch(/have NOT received your GRN/);
    expect(body).toMatch(/Please share the GRN number and date/);
    expect(body).toMatch(/AWAITED/);
  });

  it("does not nag about GRN when everything is matched or invoice-termed", () => {
    const st = buildPaymentStatement({
      customer: { id: "c1" },
      invoices: [{ ...INV, payment_terms: "Net 30" }], receipts: [], today: "2026-03-01",
    });
    expect(renderStatementText(st)).not.toMatch(/have NOT received your GRN/);
  });
});
