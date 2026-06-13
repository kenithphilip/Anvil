// End-to-end integration test for the full sales chain:
//
//   lead → opportunity → quote → sales order (draft) → approved → ERP voucher PDF
//
// Drives the REAL endpoint handlers against a shared in-memory Supabase
// fake that persists rows across calls, so the handoff at every hop is
// genuinely exercised (convert mapping, opp→quote line copy, status
// state machine, approval gate, voucher GST split). The only mocks are
// auth, audit, the in-memory db, and a few leaf libs (renderer capture,
// tally company resolver, approval evaluator). The pure tax helpers in
// tally-build-voucher + amount-words run for real.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared in-memory Supabase fake (hoisted so vi.mock can close over it) ──
const H = vi.hoisted(() => {
  const tables = {};
  let idc = 0;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const genId = () => "id-" + (++idc);

  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = "select", payload = null, countMode = false, orderSpec = null, limitN = null;
    const applyRows = () => {
      let rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (orderSpec) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderSpec.col], bv = b[orderSpec.col];
          if (av === bv) return 0;
          const c = av < bv ? -1 : 1;
          return orderSpec.asc ? c : -c;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };
    const exec = () => {
      if (op === "insert") {
        const arr = Array.isArray(payload) ? payload : [payload];
        const ins = arr.map((p) => { const row = { id: p.id || genId(), ...clone(p) }; tables[table].push(row); return clone(row); });
        return { data: ins, error: null, __rows: ins };
      }
      if (op === "update") {
        const rows = applyRows();
        rows.forEach((r) => Object.assign(r, clone(payload)));
        const out = rows.map(clone);
        return { data: out, error: null, __rows: out };
      }
      if (op === "delete") {
        const rows = applyRows();
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        return { data: null, error: null };
      }
      if (countMode) return { count: applyRows().length, data: null, error: null };
      return { data: applyRows().map(clone), error: null };
    };
    const api = {
      select: (_c, opts) => { if (opts && opts.head) countMode = true; return api; },
      insert: (p) => { op = "insert"; payload = p; return api; },
      update: (p) => { op = "update"; payload = p; return api; },
      delete: () => { op = "delete"; return api; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
      in: (c, arr) => { filters.push((r) => arr.includes(r[c])); return api; },
      gte: (c, v) => { filters.push((r) => r[c] >= v); return api; },
      lte: (c, v) => { filters.push((r) => r[c] <= v); return api; },
      like: (c, pat) => {
        const re = new RegExp("^" + String(pat).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
        filters.push((r) => re.test(r[c] || "")); return api;
      },
      not: () => { filters.push(() => true); return api; },
      order: (col, opts) => { orderSpec = { col, asc: !(opts && opts.ascending === false) }; return api; },
      limit: (n) => { limitN = n; return api; },
      single: () => { const r = exec(); const rows = r.__rows || r.data || []; const row = Array.isArray(rows) ? rows[0] : rows; return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "no rows" } }); },
      maybeSingle: () => { const r = exec(); const rows = r.__rows || r.data || []; const row = Array.isArray(rows) ? rows[0] : rows; return Promise.resolve({ data: row || null, error: null }); },
      then: (resolve, reject) => { try { resolve(exec()); } catch (e) { reject(e); } },
    };
    return api;
  }

  return {
    tables, from,
    renderArgs: [],
    reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; this.renderArgs.length = 0; },
    seed(t, rows) { if (!tables[t]) tables[t] = []; rows.forEach((r) => tables[t].push(JSON.parse(JSON.stringify(r)))); },
  };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
  hasPermission: vi.fn(() => true),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({ from: H.from, storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: "https://x/y" }, error: null }) }) } }),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: vi.fn(async () => ({ data: [], error: null })) }));
vi.mock("../api/_lib/item-mapper.js", () => ({ lineCandidates: () => [] }));
vi.mock("../api/_lib/item-customer-parts.js", () => ({ upsertCustomerPart: vi.fn(async () => {}) }));
vi.mock("../api/_lib/tally-client.js", () => ({ tallyResolveCompany: vi.fn(async () => ({ name: "Anvil Seller", gstin: "27AAACS9999A1Z5", state_code: "27" })) }));
vi.mock("../api/_lib/pdf-renderer.js", () => ({ renderVoucher: vi.fn(async (data) => { H.renderArgs.push(data); return Buffer.from("%PDF chain"); }) }));

const leadsH = (await import("../api/sales/leads.js")).default;
const quotesH = (await import("../api/quotes/index.js")).default;
const convertH = (await import("../api/quotes/convert.js")).default;
const orderH = (await import("../api/orders/[id].js")).default;
const voucherH = (await import("../api/orders/voucher_pdf.js")).default;

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  send(p) { this.body = p; return this; },
  end() { return this; },
});
const call = async (handler, { method, query = {}, body } = {}) => {
  const res = makeRes();
  await handler({ method, headers: {}, query, url: "/x", body }, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = res.body; }
  return { res, parsed };
};

beforeEach(() => {
  H.reset();
  H.seed("customers", [{
    id: "cust-1", tenant_id: "t-1", customer_name: "Tata Steel",
    gstin: "27AAACT1234A1Z5", state_code: "27", billing_address: "Mumbai",
    currency: "INR", default_quote_validity_days: 30,
  }]);
});

describe("sales chain E2E", () => {
  it("drives lead → opportunity → quote → SO(draft) → approved → ERP voucher", async () => {
    // 1. Lead
    let r = await call(leadsH, { method: "POST", body: { company_name: "Tata Steel", name: "Tata Steel", status: "NEW" } });
    expect(r.res.statusCode).toBe(201);
    const leadId = r.parsed.lead.id;

    // 2. Lead → Opportunity (convert)
    r = await call(leadsH, { method: "PATCH", body: { id: leadId, convert_to_opportunity: true, account_id: "cust-1", company_name: "Tata Steel" } });
    expect(r.res.statusCode).toBe(200);
    const oppId = r.parsed.lead.converted_opportunity_id;
    expect(oppId).toBeTruthy();
    expect(H.tables.leads[0].status).toBe("CONVERTED");
    expect(H.tables.opportunities[0]).toMatchObject({ id: oppId, customer_id: "cust-1", related_lead_id: leadId });

    // setup: operator captures opportunity line items
    H.seed("opportunity_line_items", [
      { tenant_id: "t-1", opportunity_id: oppId, line_index: 0, product_family: "Gun", product_category: "x2c", part_no: "GUN-1", qty: 3, uom: "Nos", expected_unit_price: 1000 },
      { tenant_id: "t-1", opportunity_id: oppId, line_index: 1, product_family: "Spare", part_no: null, description: "O-ring", qty: 10, uom: "pcs", expected_unit_price: 50 },
    ]);

    // 3. Opportunity → Quote (lines copy in)
    r = await call(quotesH, { method: "POST", body: { customer_id: "cust-1", opportunity_id: oppId, currency: "INR", validity_days: 30 } });
    expect(r.res.statusCode).toBe(201);
    const quote = r.parsed.quote;
    expect(quote.status).toBe("DRAFT");
    expect(quote.line_items).toHaveLength(2);
    expect(quote.subtotal).toBe(3500);             // 3*1000 + 10*50
    expect(quote.field_sources.line_items).toBe("opportunity.line_items");

    // 4. Quote → Sales Order (DRAFT)
    r = await call(convertH, { method: "POST", body: { id: quote.id } });
    expect(r.res.statusCode).toBe(200);
    const order = r.parsed.order;
    expect(order.status).toBe("DRAFT");
    expect(order.result.salesOrder.lineItems).toHaveLength(2);
    expect(r.parsed.quote.status).toBe("CONVERTED");
    const orderId = order.id;

    // 5. SO DRAFT → PENDING_REVIEW
    r = await call(orderH, { method: "PATCH", query: { id: orderId }, body: { status: "PENDING_REVIEW" } });
    expect(r.res.statusCode).toBe(200);
    expect(r.parsed.order.status).toBe("PENDING_REVIEW");

    // 6. PENDING_REVIEW → APPROVED (payload-hash gate)
    r = await call(orderH, { method: "PATCH", query: { id: orderId }, body: { status: "APPROVED", approval: { payloadHash: "h1" } } });
    expect(r.res.statusCode).toBe(200);
    expect(r.parsed.order.status).toBe("APPROVED");
    expect(r.parsed.order.approved_at).toBeTruthy();

    // 7. Approved SO → ERP voucher PDF
    r = await call(voucherH, { method: "GET", query: { orderId } });
    expect(r.res.statusCode).toBe(200);
    expect(r.res.headers["Content-Type"]).toBe("application/pdf");
    expect(H.renderArgs).toHaveLength(1);
    expect(H.renderArgs[0].taxable).toBe(3500);
    expect(H.renderArgs[0].total).toBe(3500);
    expect(H.renderArgs[0].items).toHaveLength(2);
  });

  it("refuses the voucher before approval (409 on a DRAFT order)", async () => {
    H.seed("orders", [{ id: "ord-draft", tenant_id: "t-1", status: "DRAFT", customer_id: "cust-1", result: { salesOrder: { lineItems: [] } } }]);
    const r = await call(voucherH, { method: "GET", query: { orderId: "ord-draft" } });
    expect(r.res.statusCode).toBe(409);
    expect(r.parsed.error.code).toBe("NOT_APPROVED");
    expect(H.renderArgs).toHaveLength(0);
  });

  it("blocks an illegal status jump (DRAFT → EXPORTED_TO_TALLY)", async () => {
    H.seed("orders", [{ id: "ord-x", tenant_id: "t-1", status: "DRAFT", customer_id: "cust-1", result: { salesOrder: { lineItems: [] } } }]);
    const r = await call(orderH, { method: "PATCH", query: { id: "ord-x" }, body: { status: "EXPORTED_TO_TALLY" } });
    expect(r.res.statusCode).toBe(409);
    expect(r.parsed.error.code).toBe("INVALID_STATUS_TRANSITION");
  });
});
