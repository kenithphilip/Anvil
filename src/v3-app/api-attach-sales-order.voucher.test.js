// POST /api/orders/attach_sales_order writes the ERP's voucher number onto the
// order it attaches to (orders.so_voucher_no, migration 162), so the SO PDF
// prints it. Before this, the register showed the number from the read and
// nothing wrote it to the order, so the PDF's Voucher No. was always blank.
//
// The real handler runs against the in-memory database; then the real SO PDF
// handler reads the same order, so the test follows the number from the attach
// to the page. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null, rendered: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc(), userClient: () => ({}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderSalesOrder: vi.fn(async (data) => { H.rendered.push(data); return Buffer.from("%PDF voucher"); }),
}));

const { default: attach } = await import("../api/orders/attach_sales_order.js");
const { default: soPdf } = await import("../api/orders/so_pdf.js");

const SO = (over = {}) => ({
  classification: "sales_order", voucher_no: "SO-7781", buyer_ref_order_no: "PO-VCH-0001",
  lines: [{ partNumber: "VP-1", quantity: 2 }],
  ...over,
});

const order = (id) => H.db.tables.orders.find((o) => o.id === id);
const post = (body) => callHandler(attach, { method: "POST", body });

const pdfVoucher = async (orderId) => {
  H.rendered = [];
  const r = await callHandler(soPdf, { query: { orderId } });
  expect(r.status).toBe(200);
  return H.rendered[0].voucherNo;
};

beforeEach(() => {
  H.ctx = { user: { id: "u-1" }, tenantId: "t-v", role: "sales_engineer" };
  H.rendered = [];
  H.db = createMemoryDb({
    documents: [
      { id: "doc-v", tenant_id: "t-v", filename: "erp-so.pdf" },
      { id: "doc-v2", tenant_id: "t-v", filename: "erp-so-reissued.pdf" },
    ],
    orders: [
      { id: "ord-v", tenant_id: "t-v", po_number: "PO-VCH-0001", status: "APPROVED", created_at: "2026-10-01", rule_findings: [], result: { salesOrder: { lineItems: [] } } },
      { id: "ord-held", tenant_id: "t-v", po_number: "PO-VCH-0002", status: "APPROVED", created_at: "2026-10-01", so_voucher_no: "SO-0042", rule_findings: [], result: { salesOrder: { lineItems: [] } } },
      { id: "ord-x", tenant_id: "t-x", po_number: "PO-VCH-0001", status: "APPROVED", created_at: "2026-10-01", rule_findings: [], result: { salesOrder: { lineItems: [] } } },
    ],
    order_documents: [],
    tenant_settings: [],
  }, {}, { project: true });
});

describe("attach_sales_order writes the voucher number", () => {
  it("an ERP sales order with a voucher number writes it to the order, and the SO PDF prints it", async () => {
    expect(await pdfVoucher("ord-v")).toBe("");
    const r = await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(r.body).toMatchObject({ attached: true, order: { id: "ord-v" } });
    expect(order("ord-v").so_voucher_no).toBe("SO-7781");
    expect(await pdfVoucher("ord-v")).toBe("SO-7781");
  });

  it("the buyer-reference match writes it to the caller's order and not another tenant's", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ voucher_no: "  SO-7782 " }) });
    expect(r.body).toMatchObject({ attached: true, matched_via: "buyer_reference", order: { id: "ord-v" } });
    expect(order("ord-v").so_voucher_no).toBe("SO-7782");
    expect(order("ord-x").so_voucher_no).toBeUndefined();
  });

  it("one without a voucher number leaves the order's number alone", async () => {
    for (const voucher_no of [null, "", "   ", undefined]) {
      const r = await post({ document_id: "doc-v", extracted: SO({ voucher_no, buyer_ref_order_no: "PO-VCH-0002" }), order_id: "ord-held" });
      expect(r.body.attached).toBe(true);
      expect(order("ord-held").so_voucher_no).toBe("SO-0042");
    }
    expect(await pdfVoucher("ord-held")).toBe("SO-0042");
  });

  it("a re-issued sales order replaces the number", async () => {
    await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    await post({ document_id: "doc-v2", extracted: SO({ voucher_no: "SO-7790" }), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBe("SO-7790");
  });

  it("a document read as something other than a sales order writes no number", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ classification: "invoice", voucher_no: "INV-9" }), order_id: "ord-held" });
    expect(r.body.attached).toBe(true);
    expect(order("ord-held").so_voucher_no).toBe("SO-0042");
  });

  it("an attach that does not match an order writes nothing", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ buyer_ref_order_no: "PO-NOWHERE" }) });
    expect(r.body.attached).toBe(false);
    expect(H.db.tables.orders.filter((o) => o.so_voucher_no === "SO-7781")).toEqual([]);
  });
});
