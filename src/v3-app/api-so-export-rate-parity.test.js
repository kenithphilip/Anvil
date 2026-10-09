// The Excel export and the SO PDF printed different rates on a reconciled line.
//
// The PDF read discounted_unit_price first. The quote reconciler wrote the
// QUOTE's rate into that field, while the Excel read the PO's own rate. So on a
// line where the PO and the quote disagreed, the two documents for one order
// printed different prices and different totals.
//
// The PO rate is the customer's commitment. Both exports now print it, from one
// helper, and the reconciler no longer writes the quote's rate over it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { reconcilePoAgainstQuotes } from "../api/_lib/quote-reconcile.js";
import { soLineMoney, soLinesTotal } from "../api/_lib/so-line-money.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ORDER_ID = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ store: {}, rendered: [] }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "00000000-0000-0000-0000-0000000000aa", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/storage.js", () => ({
  documentsBucket: () => "docs", ensureDocumentsBucket: async () => "docs", friendlyStorageError: (m) => m,
}));
// Capture what the SO PDF renderer is handed, which is what it prints.
vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderSalesOrder: vi.fn(async (data) => { H.rendered.push(data); return Buffer.from("%PDF so"); }),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const rows = () => H.store[table] || [];
      const flt = [];
      const b = {
        select() { return b; },
        eq(c, v) { flt.push((r) => r[c] === v); return b; },
        maybeSingle() { return Promise.resolve({ data: rows().find((r) => flt.every((f) => f(r))) || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows().filter((r) => flt.every((f) => f(r))), error: null }).then(res, rej); },
      };
      return b;
    },
  }),
}));

const { default: exportHandler } = await import("../api/orders/export.js");
const { default: soPdfHandler } = await import("../api/orders/so_pdf.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  send(p) { this.body = p; return this; },
  end(p) { if (p != null) this.body = p; return this; },
});

// The Excel: the line table between the "#" header row and the "Total" row.
const excelLines = async () => {
  const res = makeRes();
  await exportHandler({ method: "GET", headers: {}, query: { orderId: ORDER_ID } }, res);
  expect(res.statusCode).toBe(200);
  const wb = XLSX.read(res.body, { type: "buffer" });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: "" });
  const head = aoa.findIndex((r) => r[0] === "#");
  const totalRow = aoa.find((r) => r[7] === "Total");
  const rows = aoa.slice(head + 1, aoa.indexOf(totalRow));
  return {
    lines: rows.map((r) => ({ part: r[1], qty: r[5], rate: r[7], amount: r[8] })),
    total: totalRow[8],
  };
};

// The SO PDF: the items the renderer was handed.
const pdfLines = async () => {
  H.rendered = [];
  const res = makeRes();
  await soPdfHandler({ method: "GET", headers: {}, query: { orderId: ORDER_ID } }, res);
  expect(res.statusCode).toBe(200);
  const items = H.rendered[0].items;
  return {
    lines: items.map((it) => ({ part: it.partNo.replace(/\(O\/.\)$/, ""), qty: it.qty, rate: it.rate, amount: it.amount })),
    total: Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100,
  };
};

// Test parts only. Each line is a shape the reconciler really produces.
const QUOTE_LINES = [
  { _quote_id: "q1", _quote_number: "Q-TEST-1", _quote_created_at: "2026-09-01", part_no: "PART-A", description: "Test bracket", qty: 4, discounted_unit_price: 90 },
  { _quote_id: "q1", _quote_number: "Q-TEST-1", _quote_created_at: "2026-09-01", part_no: "PART-B", description: "Test flange", qty: 1, discounted_unit_price: 1200 },
  { _quote_id: "q1", _quote_number: "Q-TEST-1", _quote_created_at: "2026-09-01", part_no: "PART-C", description: "Test seal", qty: 3, discounted_unit_price: 75 },
];
const PO_LINES = [
  // The PO pays more than the quote: a price mismatch.
  { line_no: 1, part_no: "PART-A", description: "Test bracket", qty: 4, unitPrice: 250 },
  // Agrees with the quote (quote-convert writes `rate`).
  { line_no: 2, part_no: "PART-B", description: "Test flange", qty: 1, rate: 1200 },
  // The PO printed no rate: the quote's is the only price agreed.
  { line_no: 3, part_no: "PART-C", description: "Test seal", qty: 3 },
  // Quoted nowhere. An extracted `amount` that includes tax must not leak in.
  { line_no: 4, part_no: "PART-D", description: "Test gasket", qty: 5, unitPrice: 40, amount: 236 },
];
// Reconciled before this fix: the quote's rate sits in discounted_unit_price.
const LEGACY_LINE = { line_no: 5, part_no: "PART-E", description: "Test shim", qty: 2, unitPrice: 500, discounted_unit_price: 450, quote_unit_price: 450 };

const reconciledOrder = () => {
  const rec = reconcilePoAgainstQuotes(PO_LINES, QUOTE_LINES);
  return {
    id: ORDER_ID, tenant_id: TENANT, status: "PENDING_REVIEW", po_number: "PO-TEST-1",
    customer_id: null, created_at: "2026-09-02T00:00:00Z", rule_findings: [],
    result: { salesOrder: { currency: "INR", lineItems: [...rec.lines, LEGACY_LINE] } },
  };
};

beforeEach(() => {
  H.store = { orders: [reconciledOrder()] };
  H.rendered = [];
});

describe("one reconciled order through both exports", () => {
  it("prints identical line rates and amounts", async () => {
    const xl = await excelLines();
    const pdf = await pdfLines();
    expect(pdf.lines).toEqual(xl.lines);
  });

  it("prints identical totals", async () => {
    const xl = await excelLines();
    const pdf = await pdfLines();
    expect(pdf.total).toBe(xl.total);
    // 4 x 250 + 1 x 1200 + 3 x 75 + 5 x 40 + 2 x 500
    expect(xl.total).toBe(3625);
  });

  it("prints the PO's rate on a price-mismatch line, not the quote's", async () => {
    const xl = await excelLines();
    const pdf = await pdfLines();
    const a = (doc) => doc.lines.find((l) => l.part === "PART-A");
    expect(a(xl).rate).toBe(250);
    expect(a(pdf).rate).toBe(250);
  });

  it("prints the quote's rate only where the PO printed none", async () => {
    const pdf = await pdfLines();
    expect(pdf.lines.find((l) => l.part === "PART-C").rate).toBe(75);
  });

  it("prints the PO's rate on a line an older reconcile repriced", async () => {
    const xl = await excelLines();
    const pdf = await pdfLines();
    expect(xl.lines.find((l) => l.part === "PART-E").rate).toBe(500);
    expect(pdf.lines.find((l) => l.part === "PART-E").rate).toBe(500);
  });

  it("agrees with the shared helper's own total", () => {
    expect(soLinesTotal(reconciledOrder().result.salesOrder.lineItems)).toBe(3625);
    expect(soLineMoney({ quantity: 2, unit_price: "12.5" })).toEqual({ qty: 2, rate: 12.5, amount: 25 });
  });
});

describe("the reconciler keeps the PO rate", () => {
  it("leaves the PO's rate on the line and the quote's beside it", () => {
    const rec = reconcilePoAgainstQuotes(PO_LINES, QUOTE_LINES);
    const a = rec.lines.find((l) => l.part_no === "PART-A");
    expect(a._match.verdict).toBe("price_mismatch");
    expect(a.discounted_unit_price).toBe(250);
    expect(a.quote_unit_price).toBe(90);
  });

  it("still reports the price mismatch when it runs again on its own output", () => {
    // The vanishing-deviation bug: the second run read the quote's rate back
    // as the PO's and called the line matched.
    const once = reconcilePoAgainstQuotes(PO_LINES, QUOTE_LINES);
    const twice = reconcilePoAgainstQuotes(once.lines, QUOTE_LINES);
    expect(twice.summary.price_mismatch).toBe(1);
    expect(twice.lines.find((l) => l.part_no === "PART-A")._match.po_rate).toBe(250);
  });

  it("recovers the PO rate on a line an older reconcile repriced", () => {
    const rec = reconcilePoAgainstQuotes([LEGACY_LINE], [{ ...QUOTE_LINES[0], part_no: "PART-E", discounted_unit_price: 450 }]);
    expect(rec.lines[0]._match.verdict).toBe("price_mismatch");
    expect(rec.lines[0]._match.po_rate).toBe(500);
    expect(rec.lines[0].discounted_unit_price).toBe(500);
  });

  it("refills an unpriced PO line from the current quote, not the last one", () => {
    const once = reconcilePoAgainstQuotes(PO_LINES, QUOTE_LINES);
    const newer = QUOTE_LINES.map((q) => (q.part_no === "PART-C" ? { ...q, discounted_unit_price: 80 } : q));
    const twice = reconcilePoAgainstQuotes(once.lines, newer);
    const c = twice.lines.find((l) => l.part_no === "PART-C");
    expect(c._match.verdict).toBe("matched");
    expect(c.discounted_unit_price).toBe(80);
  });
});
