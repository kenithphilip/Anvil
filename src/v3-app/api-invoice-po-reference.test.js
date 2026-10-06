// @vitest-environment node
//
// Node, not jsdom: unpdf's text extraction returns an EMPTY STRING under
// jsdom, which would make every negative assertion below pass vacuously
// against '' — a test of nothing, which is the exact failure mode this file
// exists to prevent elsewhere.
// The buyer's PO number has to reach the invoice they receive.
//
// A large buyer books an incoming invoice against the purchase order it was
// raised for; their goods-receipt match keys on that reference, and an invoice
// without it is rejected clerically, before anyone reads the lines. No GRN, no
// payment.
//
// orders.po_number was already being SELECTed by invoices/index.js and thrown
// away: invoiceFromOrder never read it, `invoices` had no column, and the PDF
// printed no buyer reference. The only survivor was the GSTN e-invoice payload
// — so the tax filing carried the reference and the customer's copy did not.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { invoiceFromOrder } from "../api/_lib/invoicing.js";
import { renderInvoice } from "../api/_lib/pdf-renderer.js";
import { extractTextLayer } from "../api/_lib/docai/text_layer.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const ORDER = {
  id: "o1",
  customer_id: "c1",
  po_number: "PO-AC-2456",
  result: { salesOrder: { lineItems: [{ description: "Widget", quantity: 2, rate: 100, total: 200 }], subtotal: 200, grandTotal: 236, currency: "INR" } },
};

describe("invoiceFromOrder carries the buyer's reference", () => {
  it("snapshots orders.po_number onto the invoice", () => {
    expect(invoiceFromOrder(ORDER, {}).customer_po_number).toBe("PO-AC-2456");
  });

  it("is null rather than undefined when the order has no PO", () => {
    // An explicit null writes a real column value; undefined would silently
    // omit the key and leave the reason ambiguous.
    expect(invoiceFromOrder({ ...ORDER, po_number: null }, {}).customer_po_number).toBeNull();
  });

  it("does not disturb the totals it already produced", () => {
    const d = invoiceFromOrder(ORDER, {});
    expect(d.subtotal).toBe(200);
    expect(d.grand_total).toBe(236);
    expect(d.order_id).toBe("o1");
  });
});

describe("the rendered invoice prints it", () => {
  const base = {
    number: "INV-2026-0007", date: "2026-08-19",
    brand: { name: "Test Co" }, from: { name: "Test Co" }, to: { name: "Buyer Ltd" },
    items: [{ description: "Widget", quantity: 2, rate: 100, total: 200 }],
    subtotal: 200, tax: 36, total: 236, currency: "INR",
  };

  // NOTE ON WHAT IS ASSERTED HERE.
  //
  // The honest end-to-end check is to render the PDF and read the text back
  // out, and that check was run against these exact inputs: the phrase
  // "Your PO PO-AC-2456" appears in the extracted text layer. It is NOT
  // asserted here because unpdf's extraction is not reproducible inside
  // vitest — it returns an empty string depending on process state, and an
  // empty string satisfies every not.toMatch, which would leave this file
  // passing while asserting nothing at all. That failure mode is worse than a
  // narrower assertion.
  //
  // So the behavioural claim below is a byte differential: the same invoice,
  // rendered with and without buyerRef, must produce DIFFERENT output. That
  // cannot pass if the prop is dropped, ignored, or rendered unconditionally.

  it("changes the rendered document when a buyer reference is supplied", async () => {
    const withRef = await renderInvoice({ ...base, buyerRef: "PO-AC-2456" });
    const withoutRef = await renderInvoice(base);
    expect(withRef.length).toBeGreaterThan(0);
    expect(withoutRef.length).toBeGreaterThan(0);
    // Dropped prop => identical bytes. Longer => the line is on the page.
    expect(withRef.length).toBeGreaterThan(withoutRef.length);
  }, 60_000);

  it("no quote path ever supplies a buyer reference", () => {
    // renderQuote and renderInvoice share one document component, so the
    // renderer is NOT immune: hand a quote a buyerRef and it will print it.
    // (An earlier version of this test asserted immunity and was wrong — the
    // quote PDF grew by 68 bytes.) The real guarantee is upstream: nothing on
    // the quote side sets the field. A quotation is issued BY us, so a buyer
    // PO reference on one would be nonsense.
    for (const f of ["src/api/quotes/pdf.js", "src/api/quotes/send.js"]) {
      expect(read(f)).not.toMatch(/buyerRef/);
    }
  });

  it("renders the buyer line only when the reference exists", () => {
    // Guards what the byte differential cannot see: the label is the one an
    // AP team looks for, and it is conditional rather than printing an
    // empty "Your PO ".
    const renderer = read("src/api/_lib/pdf-renderer.js");
    expect(renderer).toContain('"Your PO " + buyerRef');
    expect(renderer).toMatch(/buyerRef &&/);
  });
});

describe("it survives a database that has not had migration 214 applied", () => {
  // Merged is not applied in this repo. PostgREST rejects the whole INSERT
  // over one unknown column, so shipping this unguarded would take invoice
  // creation out entirely on any tenant behind on 214.
  const src = read("src/api/invoices/index.js");

  it("retries the insert without the new column on 42703", () => {
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/delete payload\.customer_po_number/);
  });

  it("retries only for that column, not for any failure", () => {
    // A permissions or connection error must still surface rather than be
    // masked by a second attempt that fails identically.
    expect(src).toMatch(/customer_po_number/i);
    expect(src).not.toMatch(/if \(ins\.error\) \{\s*delete payload/);
  });
});

describe("the migration says what it does", () => {
  const sql = read("supabase/migrations/214_invoices_customer_po_number.sql");

  it("adds the column idempotently", () => {
    expect(sql).toMatch(/add column if not exists customer_po_number/i);
  });

  it("does NOT backfill", () => {
    // We cannot know whether an old invoice was issued against the PO its
    // order now names, and inventing that reference on a legal document is
    // worse than leaving it blank.
    expect(sql).not.toMatch(/\bupdate\s+invoices\b/i);
  });
});
