// A sales order knows the opportunity it was raised for.
//
// orders.opportunity_id (migration 204) is what win/loss and the shipment
// tracker read, and only 204's one-time backfill ever wrote it. These tests
// drive the real handlers that now write it: quote create (the link's source),
// quote convert, quote reconciliation and quote attach. The opportunity must
// be this tenant's and this customer's, an operator's link is never
// overwritten, and two candidate opportunities write nothing.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const OTHER_CUSTOMER = "00000000-0000-0000-0000-0000000000c2";
const ORDER = "00000000-0000-0000-0000-0000000000b1";
const OPP_A = "00000000-0000-0000-0000-00000000a001";
const OPP_B = "00000000-0000-0000-0000-00000000a002";
const OPP_OTHER_CUSTOMER = "00000000-0000-0000-0000-00000000a003";
const OPP_FOREIGN = "00000000-0000-0000-0000-00000000f001";

const H = vi.hoisted(() => ({ db: null, audits: [], writes: [], readAs: {} }));

// An in-memory Supabase. Filters, updates, inserts and upserts apply to rows.
// readAs[table] rewrites what a plain read returns, to stage a stale read.
const clone = (v) => JSON.parse(JSON.stringify(v));
let seq = 0;
const makeDb = (seed) => {
  const tables = clone(seed);
  return {
    tables,
    from(table) {
      const filters = [];
      let op = "select";
      let patch = null;
      let rowsIn = null;
      let selectAfter = false;
      let limitN = null;
      const run = async () => {
        const rows = tables[table] || (tables[table] = []);
        if (op === "insert" || op === "upsert") {
          const out = rowsIn.map((r) => ({ id: r.id || "row-" + (++seq), created_at: "2026-10-01T00:00:00Z", ...clone(r) }));
          rows.push(...out);
          return { data: clone(out), error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, clone(patch));
          H.writes.push({ table, patch: clone(patch), rows: hit.length });
          return { data: selectAfter ? clone(hit) : null, error: null };
        }
        if (limitN != null) hit = hit.slice(0, limitN);
        const out = clone(hit);
        return { data: H.readAs[table] ? H.readAs[table](out) : out, error: null };
      };
      const one = () => run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }));
      const api = {
        select() { if (op !== "select") selectAfter = true; return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return api; },
        not(c, _op, list) {
          const banned = String(list).replace(/[()]/g, "").split(",");
          filters.push((r) => !banned.includes(String(r[c])));
          return api;
        },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return api; },
        like() { return api; },
        order() { return api; },
        limit(n) { limitN = n; return api; },
        update(p) { op = "update"; patch = p; return api; },
        insert(rows) { op = "insert"; rowsIn = Array.isArray(rows) ? rows : [rows]; return api; },
        upsert(rows) { op = "upsert"; rowsIn = Array.isArray(rows) ? rows : [rows]; return api; },
        maybeSingle: one,
        single: one,
        then: (f, r) => run().then(f, r),
      };
      return api;
    },
  };
};

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db }));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-1" }, role: "sales_manager" }),
  requirePermission: () => {},
  requireAction: () => {},
  hasPermission: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push({ tenantId: ctx?.tenantId, ...p }); },
  recordEvent: async () => {},
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));

const { default: quotesHandler } = await import("../api/quotes/index.js");
const { default: convertHandler } = await import("../api/quotes/convert.js");
const { default: reconcileHandler } = await import("../api/orders/reconcile_quotes.js");
const { default: attachHandler } = await import("../api/orders/attach_quote.js");
const { linkOrderOpportunityFromQuotes } = await import("../api/_lib/order-opportunity.js");

const call = async (handler, req) => {
  const res = { setHeader() {}, end() { return res; } };
  await handler({ headers: {}, query: {}, url: "/api/x", ...req }, res);
  return res;
};

const OPPORTUNITIES = [
  { id: OPP_A, tenant_id: TENANT, customer_id: CUSTOMER, opportunity_name: "Line 4 retrofit", stage: "NEGOTIATION_REVIEW" },
  { id: OPP_B, tenant_id: TENANT, customer_id: CUSTOMER, opportunity_name: "Spares 2027", stage: "RFQ" },
  { id: OPP_OTHER_CUSTOMER, tenant_id: TENANT, customer_id: OTHER_CUSTOMER, opportunity_name: "Other buyer", stage: "RFQ" },
  // Same customer id string on purpose: only the tenant check can refuse it.
  { id: OPP_FOREIGN, tenant_id: OTHER_TENANT, customer_id: CUSTOMER, opportunity_name: "Not ours", stage: "RFQ" },
];

const PO_LINES = [
  { line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 200 },
  { line_no: 2, partNumber: "PART-B", description: "Test flange", quantity: 1, unitPrice: 1200 },
];
const quote = (over = {}) => ({
  id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-202609-0007", version: 1,
  created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "30 days credit",
  opportunity_id: OPP_A, ingest_source: null, currency: "INR", grand_total: 2000,
  ...over,
});
const qline = (quoteId, idx, part, price) => ({
  quote_id: quoteId, tenant_id: TENANT, line_index: idx, part_no: part, description: "Test part",
  qty: 1, hsn_sac: "84818090", discounted_unit_price: price,
});
const order = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "DRAFT", po_number: "PO-TEST-1",
  quote_id: null, quote_number: null, rule_findings: [], opportunity_id: null,
  incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00Z",
  result: { salesOrder: { lineItems: PO_LINES } },
  ...over,
});

const seed = ({ orders = [order()], quotes = [quote()], quoteLines = [qline("q1", 0, "PART-A", 200), qline("q1", 1, "PART-B", 1200)] } = {}) => {
  H.db = makeDb({
    orders, quotes, quote_lines: quoteLines, opportunities: OPPORTUNITIES,
    item_customer_parts: [], item_master: [], customers: [], order_documents: [],
    documents: [
      { id: "doc-own", tenant_id: TENANT, filename: "Q-202609-0007.pdf", mime_type: "application/pdf" },
      { id: "doc-scan", tenant_id: TENANT, filename: "scan.pdf", mime_type: "application/pdf" },
    ],
  });
};

const orderRow = (id = ORDER) => H.db.tables.orders.find((o) => o.id === id);
const linkedAudits = () => H.audits.filter((a) => a.action === "order_opportunity_link");
const skippedAudits = () => H.audits.filter((a) => a.action === "order_opportunity_link_skipped");
const reconcile = () => call(reconcileHandler, { method: "POST", _body: { order_id: ORDER } });

beforeEach(() => {
  H.audits = []; H.writes = []; H.readAs = {};
  seed();
});

describe("creating a quote for an opportunity", () => {
  it("stores this tenant's opportunity for the same customer", async () => {
    const res = await call(quotesHandler, { method: "POST", _body: { customer_id: CUSTOMER, opportunity_id: OPP_A, currency: "INR", validity_days: 30 } });
    expect(res._status).toBe(201);
    expect(res._json.quote.opportunity_id).toBe(OPP_A);
  });

  it("refuses another tenant's opportunity", async () => {
    const before = H.db.tables.quotes.length;
    const res = await call(quotesHandler, { method: "POST", _body: { customer_id: CUSTOMER, opportunity_id: OPP_FOREIGN } });
    expect(res._status).toBe(400);
    expect(res._json.error.code).toBe("INVALID_OPPORTUNITY");
    expect(H.db.tables.quotes).toHaveLength(before);
  });

  it("refuses another customer's opportunity", async () => {
    const res = await call(quotesHandler, { method: "POST", _body: { customer_id: CUSTOMER, opportunity_id: OPP_OTHER_CUSTOMER } });
    expect(res._status).toBe(400);
    expect(res._json.error.message).toMatch(/another customer/);
  });
});

describe("converting a quote writes the order's opportunity", () => {
  it("copies the quote's opportunity onto the new order", async () => {
    seed({ orders: [], quotes: [quote({ status: "ACCEPTED" })] });
    const res = await call(convertHandler, { method: "POST", _body: { id: "q1" } });
    expect(res._status).toBe(200);
    expect(res._json.order.opportunity_id).toBe(OPP_A);
    expect(res._json.opportunity_link).toEqual({ status: "linked", opportunity_id: OPP_A });
    expect(orderRow(res._json.order.id).opportunity_id).toBe(OPP_A);
  });

  it("refuses an opportunity from another tenant, and records why", async () => {
    seed({ orders: [], quotes: [quote({ status: "ACCEPTED", opportunity_id: OPP_FOREIGN })] });
    const res = await call(convertHandler, { method: "POST", _body: { id: "q1" } });
    expect(res._status).toBe(200);
    expect(orderRow(res._json.order.id).opportunity_id).toBeNull();
    expect(res._json.opportunity_link).toMatchObject({ status: "refused", reason: "not_found" });
    expect(skippedAudits()).toEqual([expect.objectContaining({ objectId: res._json.order.id, reason: "not_found", tenantId: TENANT })]);
  });

  it("leaves the order unattributed when the quote has no opportunity", async () => {
    seed({ orders: [], quotes: [quote({ status: "ACCEPTED", opportunity_id: null })] });
    const res = await call(convertHandler, { method: "POST", _body: { id: "q1" } });
    expect(orderRow(res._json.order.id).opportunity_id).toBeNull();
    expect(res._json.opportunity_link).toEqual({ status: "none" });
    expect(skippedAudits()).toHaveLength(0);
  });
});

describe("reconciling a PO against quotes writes the order's opportunity", () => {
  it("writes the one opportunity the matched quotes imply", async () => {
    const res = await reconcile();
    expect(res._status).toBe(200);
    expect(orderRow().opportunity_id).toBe(OPP_A);
    expect(res._json.opportunity_link).toEqual({ status: "linked", opportunity_id: OPP_A });
    expect(linkedAudits()).toHaveLength(1);
  });

  it("writes it once across runs", async () => {
    await reconcile();
    const again = await reconcile();
    expect(again._json.opportunity_link.status).toBe("already_linked");
    expect(H.writes.filter((w) => w.table === "orders" && "opportunity_id" in w.patch)).toHaveLength(1);
    expect(linkedAudits()).toHaveLength(1);
  });

  it("never overwrites an opportunity an operator set", async () => {
    seed({ orders: [order({ opportunity_id: OPP_B })] });
    const res = await reconcile();
    expect(orderRow().opportunity_id).toBe(OPP_B);
    expect(res._json.opportunity_link.status).toBe("already_linked");
    expect(linkedAudits()).toHaveLength(0);
  });

  it("writes nothing when the quotes imply two opportunities, and records why", async () => {
    seed({
      quotes: [quote(), quote({ id: "q2", quote_number: "Q-202609-0008", opportunity_id: OPP_B })],
      quoteLines: [qline("q1", 0, "PART-A", 200), qline("q2", 0, "PART-B", 1200)],
    });
    const res = await reconcile();
    expect(res._json.quotes_used).toHaveLength(2);
    expect(orderRow().opportunity_id).toBeNull();
    expect(res._json.opportunity_link.status).toBe("ambiguous");
    expect(skippedAudits()).toHaveLength(1);
    expect(skippedAudits()[0]).toMatchObject({ objectId: ORDER, reason: "ambiguous" });
    expect([...skippedAudits()[0].after.candidates].sort()).toEqual([OPP_A, OPP_B].sort());
  });

  it("records no ambiguity on an order that is already linked", async () => {
    seed({
      orders: [order({ opportunity_id: OPP_B })],
      quotes: [quote(), quote({ id: "q2", quote_number: "Q-202609-0008", opportunity_id: OPP_B })],
      quoteLines: [qline("q1", 0, "PART-A", 200), qline("q2", 0, "PART-B", 1200)],
    });
    const res = await reconcile();
    expect(res._json.opportunity_link.status).toBe("already_linked");
    expect(skippedAudits()).toHaveLength(0);
  });

  it("still links when the other matched quote has no opportunity", async () => {
    seed({
      quotes: [quote(), quote({ id: "q2", quote_number: "Q-202609-0008", opportunity_id: null })],
      quoteLines: [qline("q1", 0, "PART-A", 200), qline("q2", 0, "PART-B", 1200)],
    });
    await reconcile();
    expect(orderRow().opportunity_id).toBe(OPP_A);
  });

  it("refuses an opportunity from another tenant", async () => {
    seed({ quotes: [quote({ opportunity_id: OPP_FOREIGN })] });
    const res = await reconcile();
    expect(orderRow().opportunity_id).toBeNull();
    expect(res._json.opportunity_link).toMatchObject({ status: "refused", reason: "not_found" });
    expect(skippedAudits()[0]).toMatchObject({ reason: "not_found" });
  });

  it("refuses another customer's opportunity", async () => {
    seed({ quotes: [quote({ opportunity_id: OPP_OTHER_CUSTOMER })] });
    const res = await reconcile();
    expect(orderRow().opportunity_id).toBeNull();
    expect(res._json.opportunity_link).toMatchObject({ status: "refused", reason: "customer_mismatch" });
  });

  it("does not overwrite a link made between its read and its write", async () => {
    // The order was linked by someone else after this run read it.
    seed({ orders: [order({ opportunity_id: OPP_B })] });
    H.readAs.orders = (rows) => rows.map((r) => ({ ...r, opportunity_id: null }));
    const out = await linkOrderOpportunityFromQuotes(H.db, { tenantId: TENANT, user: { id: "u-1" } }, ORDER, ["q1"], { source: "reconcile" });
    expect(out.status).toBe("already_linked");
    expect(orderRow().opportunity_id).toBe(OPP_B);
  });

  it("never touches another tenant's order", async () => {
    seed({ orders: [order({ tenant_id: OTHER_TENANT })] });
    const out = await linkOrderOpportunityFromQuotes(H.db, { tenantId: TENANT, user: { id: "u-1" } }, ORDER, ["q1"], { source: "reconcile" });
    expect(out.status).toBe("not_found");
    expect(orderRow().opportunity_id).toBeNull();
  });

  it("makes no query without a tenant", async () => {
    const out = await linkOrderOpportunityFromQuotes(H.db, { tenantId: null }, ORDER, ["q1"], { source: "reconcile" });
    expect(out.status).toBe("skipped");
    expect(orderRow().opportunity_id).toBeNull();
  });
});

describe("attaching a quote writes the order's opportunity", () => {
  it("takes the opportunity of our own quote when its PDF is attached", async () => {
    const res = await call(attachHandler, { method: "POST", _body: { order_id: ORDER, document_id: "doc-own", extraction_attempted: false } });
    expect(res._status).toBe(200);
    expect(res._json.matched_authored).toBe(true);
    expect(res._json.opportunity_link).toEqual({ status: "linked", opportunity_id: OPP_A });
    expect(orderRow().opportunity_id).toBe(OPP_A);
  });

  it("takes it when the extracted number is one of our quotes", async () => {
    const res = await call(attachHandler, { method: "POST", _body: {
      order_id: ORDER, document_id: "doc-scan",
      extracted: { classification: "quote", quote_number: "Q-202609-0007", lines: [{ part_no: "PART-A", qty: 1, unit_price: 200 }] },
    } });
    expect(res._status).toBe(200);
    expect(res._json.matched_authored).toBe(true);
    expect(orderRow().opportunity_id).toBe(OPP_A);
  });

  it("never overwrites an opportunity an operator set", async () => {
    seed({ orders: [order({ opportunity_id: OPP_B })] });
    const res = await call(attachHandler, { method: "POST", _body: { order_id: ORDER, document_id: "doc-own", extraction_attempted: false } });
    expect(res._json.opportunity_link.status).toBe("already_linked");
    expect(orderRow().opportunity_id).toBe(OPP_B);
  });

  it("refuses an opportunity from another tenant", async () => {
    seed({ quotes: [quote({ opportunity_id: OPP_FOREIGN })] });
    const res = await call(attachHandler, { method: "POST", _body: { order_id: ORDER, document_id: "doc-own", extraction_attempted: false } });
    expect(res._json.opportunity_link).toMatchObject({ status: "refused", reason: "not_found" });
    expect(orderRow().opportunity_id).toBeNull();
  });
});
