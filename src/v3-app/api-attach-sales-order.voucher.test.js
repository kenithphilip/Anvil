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

const { default: attach, MAX_VOUCHER_LENGTH } = await import("../api/orders/attach_sales_order.js");
const { default: soPdf } = await import("../api/orders/so_pdf.js");
const { recordAudit } = await import("../api/_lib/audit.js");

const SO = (over = {}) => ({
  classification: "sales_order", voucher_no: "SO-7781", buyer_ref_order_no: "PO-VCH-0001",
  lines: [{ partNumber: "VP-1", quantity: 2 }],
  ...over,
});

const order = (id) => H.db.tables.orders.find((o) => o.id === id);
const orderIn = (tenant, id) => H.db.tables.orders.find((o) => o.tenant_id === tenant && o.id === id);
const post = (body) => callHandler(attach, { method: "POST", body });
const lastAudit = () => recordAudit.mock.calls.at(-1)[1].detail;

// An extraction run of the ERP sales order, as the read stores it.
let runSeq = 0;
const run = (over = {}) => ({
  id: "run-" + (++runSeq), tenant_id: "t-v", extraction_kind: "sales_order", source_id: "doc-v",
  status: "ok", status_reason: null, finished_at: "2026-10-05T10:00:00Z",
  normalized_extract: { classification: "sales_order", voucher_no: "SO-READ-1" },
  ...over,
});

const pdfVoucher = async (orderId) => {
  H.rendered = [];
  const r = await callHandler(soPdf, { query: { orderId } });
  expect(r.status).toBe(200);
  return H.rendered[0].voucherNo;
};

beforeEach(() => {
  H.ctx = { user: { id: "u-1" }, tenantId: "t-v", role: "sales_engineer" };
  H.rendered = [];
  recordAudit.mockClear();
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
    extraction_runs: [],
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

  it("a re-issued sales order replaces the number, and says which number it replaced", async () => {
    await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    const r = await post({ document_id: "doc-v2", extracted: SO({ voucher_no: "SO-7790" }), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBe("SO-7790");
    expect(r.body.voucher).toMatchObject({ number: "SO-7790", previous: "SO-7781", written: true, replaced: true });
    expect(lastAudit()).toMatchObject({ so_voucher_no: "SO-7790", previous_so_voucher_no: "SO-7781", so_voucher_written: true });
  });

  it("the same number again writes nothing", async () => {
    await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    const r = await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(r.body.voucher).toMatchObject({ number: "SO-7781", previous: "SO-7781", written: false, replaced: false });
    expect(lastAudit()).toMatchObject({ previous_so_voucher_no: "SO-7781", so_voucher_written: false });
    expect(order("ord-v").so_voucher_no).toBe("SO-7781");
  });

  it("a document that names a different PO does not put its number on this order", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ buyer_ref_order_no: "PO-VCH-0002" }), order_id: "ord-v" });
    expect(r.body).toMatchObject({ attached: true, match: { overrode_reference: true } });
    expect(r.body.voucher).toMatchObject({ number: "SO-7781", written: false, skipped: "reference_overridden" });
    expect(order("ord-v").so_voucher_no).toBeUndefined();
    expect(await pdfVoucher("ord-v")).toBe("");
    expect(H.db.tables.order_documents).toEqual([expect.objectContaining({ order_id: "ord-v", document_id: "doc-v" })]);
  });

  it("writes only the caller's order when another tenant has an order with the same id", async () => {
    H.db.tables.orders.push({ id: "ord-v", tenant_id: "t-x", po_number: "PO-VCH-0001", status: "APPROVED", created_at: "2026-10-01", rule_findings: [], result: { salesOrder: { lineItems: [] } } });
    const r = await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(r.body.attached).toBe(true);
    expect(orderIn("t-v", "ord-v").so_voucher_no).toBe("SO-7781");
    expect(orderIn("t-x", "ord-v").so_voucher_no).toBeUndefined();
  });

  it("a number longer than any voucher number is not written, not cut down", async () => {
    const long = "S".repeat(MAX_VOUCHER_LENGTH + 1);
    const r = await post({ document_id: "doc-v", extracted: SO({ voucher_no: long, buyer_ref_order_no: "PO-VCH-0002" }), order_id: "ord-held" });
    expect(r.body.attached).toBe(true);
    expect(order("ord-held").so_voucher_no).toBe("SO-0042");
    const fits = "S".repeat(MAX_VOUCHER_LENGTH);
    await post({ document_id: "doc-v", extracted: SO({ voucher_no: fits }), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBe(fits);
  });

  it("a document read as something other than a sales order writes no number", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ classification: "invoice", voucher_no: "INV-9", buyer_ref_order_no: "PO-VCH-0002" }), order_id: "ord-held" });
    expect(r.body.attached).toBe(true);
    expect(order("ord-held").so_voucher_no).toBe("SO-0042");
  });

  it("an attach that does not match an order writes nothing", async () => {
    const r = await post({ document_id: "doc-v", extracted: SO({ buyer_ref_order_no: "PO-NOWHERE" }) });
    expect(r.body.attached).toBe(false);
    expect(H.db.tables.orders.filter((o) => o.so_voucher_no === "SO-7781")).toEqual([]);
  });
});

describe("attach_sales_order takes the voucher number from the server's read", () => {
  it("the document's own read wins over the number in the request", async () => {
    H.db.tables.extraction_runs.push(run());
    const r = await post({ document_id: "doc-v", extracted: SO({ voucher_no: "SO-FORGED" }), order_id: "ord-v" });
    expect(r.body.voucher).toMatchObject({ number: "SO-READ-1", written: true });
    expect(order("ord-v").so_voucher_no).toBe("SO-READ-1");
    expect(lastAudit()).toMatchObject({ so_voucher_no: "SO-READ-1", so_voucher_source: "read" });
    expect(await pdfVoucher("ord-v")).toBe("SO-READ-1");
  });

  it("reads it as the register does: newest first, a dedupe hit and a read with no number skipped", async () => {
    H.db.tables.extraction_runs.push(
      run({ finished_at: "2026-10-03T10:00:00Z", normalized_extract: { classification: "sales_order", voucher_no: "SO-OLD" } }),
      run({ finished_at: "2026-10-04T10:00:00Z", normalized_extract: { classification: "sales_order", voucher_no: "SO-NEW" } }),
      run({ finished_at: "2026-10-05T10:00:00Z", normalized_extract: { classification: "sales_order" } }),
      run({ finished_at: "2026-10-06T10:00:00Z", status_reason: "dedupe_hit", normalized_extract: { classification: "sales_order", voucher_no: "SO-DEDUPE" } }),
      // Newer, but another document's read and another tenant's.
      run({ finished_at: "2026-10-07T10:00:00Z", source_id: "doc-v2", normalized_extract: { classification: "sales_order", voucher_no: "SO-OTHER-DOC" } }),
      run({ finished_at: "2026-10-08T10:00:00Z", tenant_id: "t-x", normalized_extract: { classification: "sales_order", voucher_no: "SO-OTHER-TENANT" } }),
    );
    await post({ document_id: "doc-v", extracted: SO({ voucher_no: "SO-FORGED" }), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBe("SO-NEW");
  });

  it("a read that found no number writes none, whatever the request says", async () => {
    H.db.tables.extraction_runs.push(run({ normalized_extract: { classification: "sales_order" } }));
    const r = await post({ document_id: "doc-v", extracted: SO({ voucher_no: "SO-FORGED", buyer_ref_order_no: "PO-VCH-0002" }), order_id: "ord-held" });
    expect(r.body.attached).toBe(true);
    expect(order("ord-held").so_voucher_no).toBe("SO-0042");
  });

  it("a read that classified the document as something else writes no number", async () => {
    H.db.tables.extraction_runs.push(run({ normalized_extract: { classification: "non_sales_order", voucher_no: "X-1" } }));
    await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBeUndefined();
  });

  it("with only a dedupe hit, which is not a read of its own, the request's number is used", async () => {
    H.db.tables.extraction_runs.push(run({ status_reason: "dedupe_hit", normalized_extract: { classification: "sales_order", voucher_no: "SO-DEDUPE" } }));
    await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(order("ord-v").so_voucher_no).toBe("SO-7781");
    expect(lastAudit()).toMatchObject({ so_voucher_source: "request" });
  });

  it("a read that cannot be done stores nothing", async () => {
    H.db.failRead.extraction_runs = { message: "connection reset" };
    const r = await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(r.status).toBe(500);
    expect(H.db.tables.order_documents).toEqual([]);
    expect(order("ord-v").so_voucher_no).toBeUndefined();
  });
});

describe("attach_sales_order when the voucher write fails", () => {
  it("still reports the attach, and says only the number failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    H.db.failUpdate.orders = { message: "connection reset" };
    const r = await post({ document_id: "doc-v", extracted: SO(), order_id: "ord-v" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ attached: true, order: { id: "ord-v" } });
    expect(r.body.voucher).toMatchObject({ number: "SO-7781", written: false, error: "connection reset" });
    expect(H.db.tables.order_documents).toEqual([expect.objectContaining({ order_id: "ord-v", document_id: "doc-v", role: "sales_order" })]);
    expect(order("ord-v").so_voucher_no).toBeUndefined();
    expect(lastAudit()).toMatchObject({ so_voucher_written: false, so_voucher_error: "connection reset" });
    err.mockRestore();
  });
});
