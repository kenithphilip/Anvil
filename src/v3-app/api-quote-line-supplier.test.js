// PR-A: a quote LINE can carry a chosen supplier (migration 167).
//
// Two guarantees, both on pure builders so no DB/mocking is needed:
//   1. buildQuoteLineRow (the single canonical quote_lines row builder used
//      by admin/quote_lines POST AND the spare-matrix "Feed to quote" flow)
//      persists supplier_id, and normalizes "" / undefined to null.
//   2. convert.js buildSalesOrderFromLines carries supplier_id through the
//      quote -> sales-order hop so the choice survives to the order.

import { describe, it, expect } from "vitest";
import { buildQuoteLineRow } from "../api/quotes/_lib/quote-build.js";
import { buildSalesOrderFromLines } from "../api/quotes/convert.js";

describe("buildQuoteLineRow supplier_id", () => {
  it("persists a supplied supplier_id", () => {
    const row = buildQuoteLineRow("t-1", "q-1", {
      line_index: 0, part_no: "P1", supplier_id: "sup-123",
    });
    expect(row.supplier_id).toBe("sup-123");
  });

  it("normalizes missing / blank supplier_id to null", () => {
    expect(buildQuoteLineRow("t-1", "q-1", { line_index: 0 }).supplier_id).toBeNull();
    expect(buildQuoteLineRow("t-1", "q-1", { line_index: 1, supplier_id: "" }).supplier_id).toBeNull();
  });

  it("keeps supplier_id independent of source_country", () => {
    const row = buildQuoteLineRow("t-1", "q-1", {
      line_index: 0, source_country: "INDIA", supplier_id: "sup-9",
    });
    expect(row.source_country).toBe("INDIA");
    expect(row.supplier_id).toBe("sup-9");
  });
});

describe("convert carries supplier_id to the sales order", () => {
  it("maps quote_lines.supplier_id onto the SO line items", () => {
    const { salesOrder } = buildSalesOrderFromLines(
      { currency: "INR", subtotal: 100, tax_total: 0, grand_total: 100 },
      [
        { line_index: 0, part_no: "P1", qty: 2, listed_unit_price: 50, supplier_id: "sup-123" },
        { line_index: 1, part_no: "P2", qty: 1, listed_unit_price: 10 },
      ],
    );
    expect(salesOrder.lineItems[0].supplier_id).toBe("sup-123");
    expect(salesOrder.lineItems[1].supplier_id).toBeNull();
  });
});
