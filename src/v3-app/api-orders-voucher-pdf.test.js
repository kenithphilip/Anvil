// Handler tests for src/api/orders/voucher_pdf.js — the ERP-format
// sales-order voucher PDF. We mock auth/supabase/renderer/storage but
// use the REAL pure tax helpers (tally-build-voucher) so the CGST/SGST
// vs IGST split is genuinely exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  order: null,
  customer: { customer_name: "Tata Steel", gstin: "27AAACT1234A1Z5", state_code: "27", billing_address: "Mumbai" },
  company: { name: "Anvil Seller", gstin: "27AAACS9999A1Z5", state_code: "27" },
  renderArgs: [],
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/storage.js", () => ({
  documentsBucket: () => "docs",
  ensureDocumentsBucket: async () => "docs",
  friendlyStorageError: (m) => m,
}));
vi.mock("../api/_lib/tally-client.js", () => ({
  tallyResolveCompany: vi.fn(async () => h.company),
}));
vi.mock("../api/_lib/tally-voucher-type.js", () => ({
  resolveSalesVoucherType: () => "Sales",
}));
// Capture what the renderer is handed; return fake PDF bytes.
vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderVoucher: vi.fn(async (data) => { h.renderArgs.push(data); return Buffer.from("%PDF voucher"); }),
}));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: (table) => {
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => {
          if (table === "orders") return { data: h.order, error: null };
          if (table === "customers") return { data: h.customer, error: null };
          if (table === "tenants") return { data: { display_name: "Anvil" }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/orders/voucher_pdf.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null, _ended: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  send(p) { this.body = p; return this; },
  end(p) { this._ended = p; return this; },
});

const run = async (query) => {
  const res = makeRes();
  await handler({ method: "GET", headers: {}, query }, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = res.body; }
  return { res, parsed };
};

const APPROVED_ORDER = {
  id: "ord-1", status: "APPROVED", po_number: "PO-7788", quote_number: "Q-1",
  customer_id: "cust-1", created_at: "2026-06-01T00:00:00Z", approved_at: "2026-06-02T00:00:00Z",
  result: { salesOrder: { currency: "INR", lineItems: [
    { part_no: "BR-6204", description: "Bearing", hsn: "8482", qty: 2, discounted_unit_price: 100, gst_pct: 18, uom: "Nos" },
  ] } },
};

beforeEach(() => {
  h.order = JSON.parse(JSON.stringify(APPROVED_ORDER));
  h.customer = { customer_name: "Tata Steel", gstin: "27AAACT1234A1Z5", state_code: "27", billing_address: "Mumbai" };
  h.company = { name: "Anvil Seller", gstin: "27AAACS9999A1Z5", state_code: "27" };
  h.renderArgs = [];
});

describe("GET /api/orders/voucher_pdf", () => {
  it("blocks a draft order with 409 NOT_APPROVED and never renders", async () => {
    h.order.status = "DRAFT";
    const { res, parsed } = await run({ orderId: "ord-1" });
    expect(res.statusCode).toBe(409);
    expect(parsed.error.code).toBe("NOT_APPROVED");
    expect(h.renderArgs).toHaveLength(0);
  });

  it("requires orderId", async () => {
    const { res } = await run({});
    expect(res.statusCode).toBe(400);
  });

  it("renders an intrastate voucher (CGST+SGST, no IGST) for same-state party", async () => {
    const { res } = await run({ orderId: "ord-1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/pdf");
    const d = h.renderArgs[0];
    expect(d.placeOfSupply).toMatch(/Intrastate/);
    expect(d.taxable).toBe(200);
    expect(d.cgst).toBe(18);
    expect(d.sgst).toBe(18);
    expect(d.igst).toBe(0);
    expect(d.total).toBe(236);
    expect(d.items[0]).toMatchObject({ partNumber: "BR-6204", hsn: "8482", gstPct: 18, taxable: 200 });
    expect(d.totalInWords).toMatch(/Two Hundred Thirty Six INR Only/);
  });

  it("renders an interstate voucher (IGST, no CGST/SGST) for different-state party", async () => {
    h.customer.state_code = "29"; h.customer.gstin = "29AAACT1234A1Z5";
    const { res } = await run({ orderId: "ord-1" });
    expect(res.statusCode).toBe(200);
    const d = h.renderArgs[0];
    expect(d.placeOfSupply).toMatch(/Interstate/);
    expect(d.igst).toBe(36);
    expect(d.cgst).toBe(0);
    expect(d.sgst).toBe(0);
    expect(d.total).toBe(236);
  });
});
