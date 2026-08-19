// Does the invoice agree with the customer's PO?
//
// A large buyer books an incoming invoice against the purchase order it was
// raised for. Lines, quantities or prices that disagree mean no goods receipt,
// and no GRN means no payment. These tests are about the cases that actually
// get an invoice rejected — and, just as importantly, the cases that do NOT,
// because a check that cries wolf on every partial shipment is worse than none.

import { describe, it, expect } from "vitest";
import {
  reconcileInvoiceAgainstOrder, billedQtyByPart, countsTowardBilled,
  compareTotals, COUNTED_INVOICE_STATUSES,
} from "../api/_lib/invoice-reconcile.js";

// Deliberately mixed spellings: order lines and invoice lines are both JSONB
// written by several code paths, and the comparison has to survive that.
const PO = [
  { partNumber: "BP8-3S", description: "Socket", quantity: 30, rate: 1872 },
  { part_no: "S8/M8-57AG", description: "Threaded pin", qty: 30, unit_price: 823 },
];

describe("a clean invoice", () => {
  it("matches every line and can be sent", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [
      { partNumber: "BP8-3S", description: "Socket", quantity: 30, rate: 1872 },
      { partNumber: "S8/M8-57AG", description: "Threaded pin", quantity: 30, rate: 823 },
    ]);
    expect(r.summary.matched).toBe(2);
    expect(r.summary.blocking).toBe(0);
    expect(r.can_send).toBe(true);
  });

  it("matches across punctuation and case differences in the part code", () => {
    // bp8/3s and BP8-3S are the same part; the PO and the invoice were written
    // by different code paths.
    const r = reconcileInvoiceAgainstOrder(PO, [{ part_no: "bp8/3s", quantity: 30, rate: 1872 }]);
    expect(r.lines[0].verdict).toBe("matched");
  });

  it("does NOT match a part code differing by one character", () => {
    // BP8/35 vs BP8/3S — a digit is not a letter, and a near-miss on a part
    // code is a different SKU.
    const r = reconcileInvoiceAgainstOrder(PO, [{ part_no: "BP8/35", quantity: 30, rate: 1872 }]);
    expect(r.lines[0].verdict).toBe("not_on_po");
  });
});

describe("the cases that get a receipt rejected", () => {
  it("flags a line the PO never ordered, and blocks", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "SOMETHING-ELSE", quantity: 1, rate: 100 }]);
    expect(r.lines[0].verdict).toBe("not_on_po");
    expect(r.lines[0].blocking).toBe(true);
    expect(r.can_send).toBe(false);
  });

  it("flags a price the PO does not carry, and blocks", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 30, rate: 1910 }]);
    expect(r.lines[0].verdict).toBe("price_mismatch");
    expect(r.lines[0].blocking).toBe(true);
    // 1910 vs 1872 — the list-vs-discounted difference from a real quote.
    expect(r.lines[0].price_delta_pct).toBeCloseTo(2.03, 1);
  });

  it("is EXACT on price by default", () => {
    // An invoice is a demand for a specific sum; the quote hop's 0.5% slack is
    // wrong here. A tenant that wants tolerance must ask for it.
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 30, rate: 1873 }]);
    expect(r.lines[0].verdict).toBe("price_mismatch");
    const loose = reconcileInvoiceAgainstOrder(
      PO, [{ partNumber: "BP8-3S", quantity: 30, rate: 1873 }], [], { priceTolerancePct: 1 },
    );
    expect(loose.lines[0].verdict).toBe("matched");
  });

  it("reports a description that has completely changed, but does NOT block on it", () => {
    // Buyers match on code and quantity; a wording difference is worth showing
    // and is not a reason to hold the invoice.
    const r = reconcileInvoiceAgainstOrder(PO, [
      { partNumber: "BP8-3S", description: "Hydraulic pump assembly bracket", quantity: 30, rate: 1872 },
    ]);
    expect(r.lines[0].verdict).toBe("description_mismatch");
    expect(r.lines[0].blocking).toBe(false);
    expect(r.can_send).toBe(true);
  });
});

describe("partial invoicing is normal and must not be flagged", () => {
  it("accepts an invoice for fewer units than ordered", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 10, rate: 1872 }]);
    expect(r.lines[0].verdict).toBe("matched");
    expect(r.can_send).toBe(true);
  });

  it("lists what is still outstanding without calling it a discrepancy", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 10, rate: 1872 }]);
    const outstanding = r.not_invoiced.map((n) => n.part_no);
    expect(outstanding).toContain("S8/M8-57AG");
    expect(r.summary.blocking).toBe(0);
  });

  it("nets prior invoices off the remaining quantity", () => {
    const prior = [{ status: "sent", line_items: [{ partNumber: "BP8-3S", quantity: 20, rate: 1872 }] }];
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "S8/M8-57AG", quantity: 30, rate: 823 }], prior);
    const socket = r.not_invoiced.find((n) => n.part_no === "BP8-3S");
    expect(socket.previously_billed_qty).toBe(20);
    expect(socket.remaining_qty).toBe(10);
  });

  it("stops listing a part once earlier invoices covered it in full", () => {
    const prior = [{ status: "paid", line_items: [{ partNumber: "BP8-3S", quantity: 30, rate: 1872 }] }];
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "S8/M8-57AG", quantity: 30, rate: 823 }], prior);
    expect(r.not_invoiced.map((n) => n.part_no)).not.toContain("BP8-3S");
  });
});

describe("over-invoicing is cumulative, which is the whole point", () => {
  it("passes an invoice that alone is within the ordered quantity", () => {
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 20, rate: 1872 }]);
    expect(r.lines[0].verdict).toBe("matched");
  });

  it("catches the SAME invoice once earlier ones are counted", () => {
    // 20 already billed + 20 now = 40 against 30 ordered. Neither invoice is
    // wrong on its own, which is exactly why a per-invoice check misses it.
    const prior = [{ status: "sent", line_items: [{ partNumber: "BP8-3S", quantity: 20, rate: 1872 }] }];
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 20, rate: 1872 }], prior);
    expect(r.lines[0].verdict).toBe("qty_over_ordered");
    expect(r.lines[0].blocking).toBe(true);
    expect(r.lines[0].previously_billed_qty).toBe(20);
    expect(r.lines[0].cumulative_billed_qty).toBe(40);
    expect(r.lines[0].over_by).toBe(10);
  });

  it("ignores draft invoices — an unsent invoice has billed nobody", () => {
    const prior = [{ status: "draft", line_items: [{ partNumber: "BP8-3S", quantity: 30, rate: 1872 }] }];
    const r = reconcileInvoiceAgainstOrder(PO, [{ partNumber: "BP8-3S", quantity: 30, rate: 1872 }], prior);
    expect(r.lines[0].verdict).toBe("matched");
  });

  it("ignores void invoices, by status and by voided_at", () => {
    expect(countsTowardBilled({ status: "void" })).toBe(false);
    expect(countsTowardBilled({ status: "sent", voided_at: "2026-08-01T00:00:00Z" })).toBe(false);
    expect(countsTowardBilled({ status: "sent" })).toBe(true);
  });

  it("counts exactly the statuses that reached the customer", () => {
    expect([...COUNTED_INVOICE_STATUSES].sort()).toEqual(["overdue", "paid", "partial", "sent"]);
    // draft and void are the two the invoices check constraint also allows.
    for (const s of ["draft", "void"]) expect(COUNTED_INVOICE_STATUSES).not.toContain(s);
  });

  it("sums the same part across several prior invoices", () => {
    const billed = billedQtyByPart([
      { status: "sent", line_items: [{ partNumber: "BP8-3S", quantity: 5 }] },
      { status: "paid", line_items: [{ part_no: "bp8/3s", qty: 7 }] },
      { status: "draft", line_items: [{ partNumber: "BP8-3S", quantity: 100 }] },
    ]);
    expect(billed.get("BP83S")).toBe(12);
  });
});

describe("things it reports rather than guesses", () => {
  it("marks a part that appears twice on the PO as ambiguous", () => {
    const dup = [...PO, { partNumber: "BP8-3S", description: "Socket", quantity: 5, rate: 999 }];
    const r = reconcileInvoiceAgainstOrder(dup, [{ partNumber: "BP8-3S", quantity: 30, rate: 1872 }]);
    // First occurrence wins, and the caller is told the answer was not certain.
    expect(r.lines[0].ambiguous).toBe(true);
  });

  it("does not treat a zero PO rate as a price", () => {
    // The spare-matrix feed writes 0 by design; comparing against it would
    // report every line as an infinite mismatch.
    const r = reconcileInvoiceAgainstOrder([{ partNumber: "X", quantity: 1, rate: 0 }], [{ partNumber: "X", quantity: 1, rate: 500 }]);
    expect(r.lines[0].verdict).toBe("matched");
    expect(r.lines[0].price_delta_pct).toBeNull();
  });

  it("handles an empty invoice without inventing discrepancies", () => {
    const r = reconcileInvoiceAgainstOrder(PO, []);
    expect(r.summary.total).toBe(0);
    expect(r.can_send).toBe(true);
    expect(r.not_invoiced).toHaveLength(2);
  });
});

describe("totals", () => {
  it("compares the invoice grand total against the PO line total", () => {
    const t = compareTotals(30 * 1872 + 30 * 823, PO);
    expect(t.po_line_total).toBe(80850);
    expect(t.mismatch).toBe(false);
  });

  it("flags a total that does not agree", () => {
    expect(compareTotals(82500, PO).mismatch).toBe(true);
  });
});

describe("the endpoint stays read-only", () => {
  it("writes nothing", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/api/orders/reconcile_invoice.js", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(code).not.toContain(w);
    }
  });

  it("guards the migration-214 column, which is applied by hand", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/api/orders/reconcile_invoice.js", "utf8");
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/poRefKnown/);
  });
});
