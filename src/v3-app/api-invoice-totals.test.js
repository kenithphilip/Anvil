// An invoice must not be raised for NaN, or for zero.
//
// invoiceFromOrder derived its subtotal from `it.total`, `it.rate` and
// `it.quantity` — a vocabulary NO producer of these lines emits. DocAI
// extraction writes lineTotal / unitPrice / quantity (docai/line-schema.js);
// quotes/convert.js writes amount / rate / qty. Neither carries `total`.
//
// Number(undefined) is NaN and NaN is falsy, so `Number(it.total) || ...` fell
// through to `Number(it.rate) * Number(it.quantity || 0)`, which gave NaN for
// an extracted order (rate absent too) and rate * 0 for a converted one
// (quantity absent). Both went straight onto the invoice.
//
// It only stayed hidden because so.subtotal is usually present. The fallback
// exists precisely for when it is not.

import { describe, it, expect } from "vitest";
import { invoiceFromOrder } from "../api/_lib/invoicing.js";

const order = (lineItems, so = {}) => ({
  id: "o1", customer_id: "c1", po_number: "PO-1",
  result: { salesOrder: { lineItems, ...so } },
});

describe("totals are derived from the lines that actually exist", () => {
  it("handles the DocAI dialect: quantity / unitPrice / lineTotal", () => {
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100, lineTotal: 200 }]), {});
    expect(d.subtotal).toBe(200);
    expect(Number.isNaN(d.subtotal)).toBe(false);
    expect(Number.isNaN(d.grand_total)).toBe(false);
  });

  it("handles the quote-conversion dialect: qty / rate / amount", () => {
    const d = invoiceFromOrder(order([{ partNumber: "A", qty: 2, rate: 100, amount: 200 }]), {});
    expect(d.subtotal).toBe(200);
  });

  it("derives qty x rate when no printed line total is present", () => {
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100 }]), {});
    expect(d.subtotal).toBe(200);
  });

  it("sums a mixed-dialect order — operator edits and extraction disagree", () => {
    const d = invoiceFromOrder(order([
      { partNumber: "A", quantity: 2, unitPrice: 100, lineTotal: 200 },
      { partNumber: "B", qty: 1, rate: 50, amount: 50 },
    ]), {});
    expect(d.subtotal).toBe(250);
  });

  it("never emits NaN, whatever the line shape", () => {
    for (const lines of [
      [{ partNumber: "A" }],
      [{ partNumber: "A", quantity: "two", unitPrice: "lots" }],
      [{}],
      [],
    ]) {
      const d = invoiceFromOrder(order(lines), {});
      expect(Number.isNaN(d.subtotal)).toBe(false);
      expect(Number.isNaN(d.grand_total)).toBe(false);
      expect(Number.isNaN(d.tax_total)).toBe(false);
    }
  });
});

describe("a stated header total still wins", () => {
  it("prefers so.subtotal over the derived sum", () => {
    // The header figure is what the customer agreed; the lines are a fallback.
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100 }], { subtotal: 195 }), {});
    expect(d.subtotal).toBe(195);
  });

  it("respects a genuine zero rather than falling through to the lines", () => {
    // `Number(x) || fallback` cannot tell 0 from missing. A zero-value order
    // is unusual but real (a free replacement), and re-deriving 200 for it
    // would invoice a customer for goods we agreed to give them.
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100 }], { subtotal: 0 }), {});
    expect(d.subtotal).toBe(0);
  });

  it("falls through when the header total is not a number", () => {
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100 }], { subtotal: "n/a" }), {});
    expect(d.subtotal).toBe(200);
  });

  it("prefers grandTotal, then total, then subtotal + tax", () => {
    const lines = [{ partNumber: "A", quantity: 2, unitPrice: 100 }];
    expect(invoiceFromOrder(order(lines, { grandTotal: 236 }), {}).grand_total).toBe(236);
    expect(invoiceFromOrder(order(lines, { total: 240 }), {}).grand_total).toBe(240);
    expect(invoiceFromOrder(order(lines, { taxTotal: 36 }), {}).grand_total).toBe(236);
  });

  it("reads gstTotal as well as taxTotal", () => {
    const d = invoiceFromOrder(order([{ partNumber: "A", quantity: 2, unitPrice: 100 }], { gstTotal: 36 }), {});
    expect(d.tax_total).toBe(36);
    expect(d.grand_total).toBe(236);
  });
});

describe("it still carries what it carried before", () => {
  it("keeps the buyer PO reference and the line items", () => {
    const lines = [{ partNumber: "A", quantity: 2, unitPrice: 100 }];
    const d = invoiceFromOrder(order(lines), {});
    expect(d.customer_po_number).toBe("PO-1");
    expect(d.order_id).toBe("o1");
    expect(d.line_items).toBe(lines);
  });
});
