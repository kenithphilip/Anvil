// Quote reconciliation runs on the server once an order's lines are written.
//
// Only the intake screen used to run it, straight after creating a draft. An
// order whose lines landed any other way was never analysed until someone
// clicked: lines extracted in the workspace for an order that came in by
// email, WhatsApp or voice, and lines the background large-PO job wrote back.
//
// The server now runs the same reconciliation after the write, once per
// payload hash, never on an approved order, and never at the cost of the write.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, audits: [], events: [], writes: [], fail: {}, onRead: {}, delay: {} }));

// ── An in-memory Supabase: filters, updates and inserts apply to rows, and
// every update bumps updated_at the way the 001_init trigger does. ────────

const clone = (v) => JSON.parse(JSON.stringify(v));
let clock = Date.parse("2026-10-01T00:00:00Z");
const nextStamp = () => new Date((clock += 1000)).toISOString();
let seq = 0;

const makeDb = (seed) => {
  const tables = clone(seed);
  return {
    tables,
    from(table) {
      if (H.fail[table] === "throw") throw new Error(table + " exploded");
      const filters = [];
      let op = "select";
      let patch = null;
      let rowsIn = null;
      let selectAfter = false;
      const run = async () => {
        if (H.delay[table]) await new Promise((r) => setTimeout(r, H.delay[table]));
        if (H.fail[table] === "error") return { data: null, error: { message: table + " unavailable" } };
        const rows = tables[table] || (tables[table] = []);
        if (op === "insert") {
          const out = rowsIn.map((r) => ({ id: r.id || "row-" + (++seq), created_at: nextStamp(), updated_at: nextStamp(), ...clone(r) }));
          rows.push(...out);
          return { data: clone(out), error: null };
        }
        if (op === "select" && H.onRead[table]) await H.onRead[table]();
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, clone(patch), { updated_at: nextStamp() });
          H.writes.push({ table, patch: clone(patch), rows: hit.length });
          return { data: selectAfter ? clone(hit) : null, error: null };
        }
        return { data: clone(hit), error: null };
      };
      const one = () => run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }));
      const api = {
        select() { if (op !== "select") selectAfter = true; return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        neq(c, v) { filters.push((r) => String(r[c]) !== String(v)); return api; },
        in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return api; },
        not(c, _op, list) {
          const banned = String(list).replace(/[()]/g, "").split(",");
          filters.push((r) => !banned.includes(String(r[c])));
          return api;
        },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return api; },
        gte() { return api; },
        order() { return api; },
        limit() { return api; },
        update(p) { op = "update"; patch = p; return api; },
        insert(rows) { op = "insert"; rowsIn = Array.isArray(rows) ? rows : [rows]; return api; },
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
  resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-1" }, role: "sales_engineer" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push({ tenantId: ctx?.tenantId, ...p }); },
  recordEvent: async (ctx, p) => { H.events.push({ tenantId: ctx?.tenantId, ...p }); },
}));
// Item mapping is its own concern and talks to tables this test does not seed.
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));

const { default: createOrder } = await import("../api/orders/index.js");
const { default: patchOrder } = await import("../api/orders/[id].js");
const { default: reconcileEndpoint } = await import("../api/orders/reconcile_quotes.js");
const { autoReconcileOrder } = await import("../api/_lib/order-reconcile.js");
const { __test: jobsTest } = await import("../api/cron/extraction_jobs.js");

const call = async (handler, req) => {
  const res = { setHeader() {}, end() { return res; } };
  await handler({ headers: {}, query: {}, url: "/api/orders", ...req }, res);
  return res;
};

// The PO prints no HSN and pays more than the quote on one line. The quote
// carries the HSN, so the reconciler fills it, which moves the payload hash.
const PO_LINES = [
  { line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 250 },
  { line_no: 2, partNumber: "PART-B", description: "Test flange", quantity: 1, unitPrice: 1200 },
];
const QUOTE = { id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-1", created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "30 days credit" };
const QUOTE_LINES = [
  { quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, hsn_sac: "84818090", discounted_unit_price: 200 },
  { quote_id: "q1", tenant_id: TENANT, line_index: 1, part_no: "PART-B", description: "Test flange", qty: 1, hsn_sac: "84818090", discounted_unit_price: 1200 },
];

// An order an inbound channel created: no lines yet, a customer, a draft.
const inboundOrder = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "DRAFT", po_number: "PO-TEST-1",
  quote_id: null, quote_number: null, rule_findings: [], approval: null, payload_hash: null,
  incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
  preflight_payload: { source: "email_inbound", subject: "PO attached" },
  result: {},
  ...over,
});

const seed = (orders = [inboundOrder()]) => {
  H.db = makeDb({
    orders,
    quotes: [QUOTE, { ...QUOTE, id: "q-other", tenant_id: OTHER_TENANT }],
    quote_lines: [...QUOTE_LINES, { ...QUOTE_LINES[0], quote_id: "q-other", tenant_id: OTHER_TENANT, discounted_unit_price: 1 }],
    item_customer_parts: [],
    item_master: [],
  });
};

const orderRow = (id = ORDER) => H.db.tables.orders.find((o) => o.id === id);
const reconAudits = () => H.audits.filter((a) => a.action === "order_reconcile_quotes");
const orderWrites = () => H.writes.filter((w) => w.table === "orders");

beforeEach(() => {
  H.audits = []; H.events = []; H.writes = []; H.fail = {}; H.onRead = {}; H.delay = {};
  seed();
});

describe("an inbound-created order gets a reconciliation", () => {
  it("when its lines land through the workspace extraction", async () => {
    // The order came in by email with no lines. Extracting in the workspace
    // PATCHes the lines on, and nobody clicks reconcile.
    const res = await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    expect(res._status).toBe(200);
    const recon = orderRow().result.quoteReconciliation;
    expect(recon.trigger).toBe("lines_changed");
    expect(recon.summary).toMatchObject({ total: 2, matched: 1, price_mismatch: 1 });
    expect(recon.flags.map((f) => f.verdict)).toEqual(["price_mismatch"]);
    // The other tenant's quote, at a rate of 1, was never read.
    expect(recon.quotes_used.map((q) => q.quote_number)).toEqual(["Q-TEST-1"]);
    expect(orderRow().quote_number).toBe("Q-TEST-1");
  });

  it("when the background large-PO job writes its lines back", async () => {
    H.db.tables.extraction_jobs = [{
      id: "job-1", tenant_id: TENANT, order_id: ORDER, customer_id: CUSTOMER, document_id: null,
      extraction_kind: "po", status: "merging",
      chunk_status: [{ index: 0, page_start: 1, page_end: 30, page_count: 30, status: "done", attempts: 1 }],
      partial_result: { chunk_results: [{
        ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: { overall: 0.9 }, attempts: [],
        normalized: { classification: "po", customer: { name: "Test Buyer" }, lines: PO_LINES },
      }] },
    }];
    const { job } = await jobsTest.advanceJob(H.db, clone(H.db.tables.extraction_jobs[0]));
    expect(job.status).toBe("completed");
    const recon = orderRow().result.quoteReconciliation;
    expect(recon.trigger).toBe("background_extraction");
    expect(recon.summary.total).toBe(2);
    expect(recon.summary.price_mismatch).toBe(1);
  });

  it("when an order is created with its lines", async () => {
    seed([]);
    const res = await call(createOrder, { method: "POST", _body: {
      customer_id: CUSTOMER, po_number: "PO-TEST-2",
      preflight_payload: { source: "api" }, result: { salesOrder: { lineItems: PO_LINES } },
    } });
    expect(res._status).toBe(201);
    const recon = orderRow(res._json.order.id).result.quoteReconciliation;
    expect(recon.trigger).toBe("order_created");
    expect(recon.summary.price_mismatch).toBe(1);
  });

  it("carries the terms check too", async () => {
    seed([inboundOrder({ incoterm_code: "EXW" })]);
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    const recon = orderRow().result.quoteReconciliation;
    expect(recon.payment_terms.quote_terms).toBe("30 days credit");
    expect(recon.incoterms.verdict).toBe("quote_missing");
  });
});

describe("a re-run on the same payload hash is a no-op", () => {
  it("writes nothing and audits nothing the second time", async () => {
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    const first = clone(orderRow().result.quoteReconciliation);
    expect(reconAudits()).toHaveLength(1);
    const writesBefore = orderWrites().length;

    const again = await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed" });
    expect(again.status).toBe("unchanged");
    expect(orderWrites()).toHaveLength(writesBefore);
    expect(reconAudits()).toHaveLength(1);
    expect(orderRow().result.quoteReconciliation).toEqual(first);
  });

  it("is a no-op when the screen saves the lines it was given back", async () => {
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    // The workspace reloads and saves the reconciled order unchanged.
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: clone(orderRow().result) } });
    expect(reconAudits()).toHaveLength(1);
  });

  it("hands the intake screen the stored report instead of running again", async () => {
    seed([]);
    const created = await call(createOrder, { method: "POST", _body: {
      customer_id: CUSTOMER, po_number: "PO-TEST-3", result: { salesOrder: { lineItems: PO_LINES } },
    } });
    const id = created._json.order.id;
    const res = await call(reconcileEndpoint, { method: "POST", _body: { order_id: id, if_changed: true } });
    expect(res._status).toBe(200);
    expect(res._json.skipped).toBe("unchanged");
    expect(res._json.summary.price_mismatch).toBe(1);
    expect(reconAudits()).toHaveLength(1);
  });

  it("runs again when a line changes", async () => {
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    const edited = clone(orderRow().result);
    edited.salesOrder.lineItems[0].unitPrice = 200;
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: edited } });
    expect(reconAudits()).toHaveLength(2);
    expect(orderRow().result.quoteReconciliation.summary.price_mismatch).toBe(0);
  });

  it("does not duplicate a blocking finding across runs", async () => {
    seed([inboundOrder()]);
    H.db.tables.quote_lines.push({ quote_id: "q1", tenant_id: TENANT, line_index: 2, part_no: "PART-C-MOD", description: "Test guide", qty: 1, discounted_unit_price: 10 });
    const lines = [...PO_LINES, { line_no: 3, partNumber: "PART-C-MOD", description: "Test guide", quantity: 1, unitPrice: 10 }];
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: lines } } } });
    await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed" });
    await call(reconcileEndpoint, { method: "POST", _body: { order_id: ORDER } });
    const mod = orderRow().rule_findings.filter((f) => (f.code || f.rule_id) === "mod_quote_bom_pending");
    expect(mod).toHaveLength(1);
  });

  it("the screen's own reconcile button still forces a run", async () => {
    // A newly attached quote changes the answer without changing the PO.
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    const res = await call(reconcileEndpoint, { method: "POST", _body: { order_id: ORDER } });
    expect(res._json.skipped).toBeUndefined();
    expect(reconAudits()).toHaveLength(2);
  });
});

describe("a reconcile error leaves the order intact", () => {
  it("on create: the order is created, with its lines, and the failure is an event", async () => {
    seed([]);
    H.fail.quotes = "error";
    const res = await call(createOrder, { method: "POST", _body: {
      customer_id: CUSTOMER, po_number: "PO-TEST-4", result: { salesOrder: { lineItems: PO_LINES } },
    } });
    expect(res._status).toBe(201);
    const row = orderRow(res._json.order.id);
    expect(row.result.salesOrder.lineItems.map((l) => l.partNumber)).toEqual(["PART-A", "PART-B"]);
    expect(row.result.quoteReconciliation).toBeUndefined();
    const ev = H.events.find((e) => e.eventType === "quote_reconcile_failed");
    expect(ev.caseId).toBe(row.id);
    expect(ev.detail.trigger).toBe("order_created");
  });

  it("on a line save: the save stands even when the reconciler throws", async () => {
    H.fail.quote_lines = "throw";
    const res = await call(patchOrder, { method: "PATCH", query: { id: ORDER }, _body: { result: { salesOrder: { lineItems: PO_LINES } } } });
    expect(res._status).toBe(200);
    expect(orderRow().result.salesOrder.lineItems).toEqual(PO_LINES);
    expect(H.events.some((e) => e.eventType === "quote_reconcile_failed")).toBe(true);
  });

  it("in the background job: the job completes with the lines written", async () => {
    H.fail.quotes = "error";
    H.db.tables.extraction_jobs = [{
      id: "job-2", tenant_id: TENANT, order_id: ORDER, customer_id: CUSTOMER, document_id: null,
      extraction_kind: "po", status: "merging",
      chunk_status: [{ index: 0, page_start: 1, page_end: 30, page_count: 30, status: "done", attempts: 1 }],
      partial_result: { chunk_results: [{
        ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: { overall: 0.9 }, attempts: [],
        normalized: { classification: "po", customer: { name: "Test Buyer" }, lines: PO_LINES },
      }] },
    }];
    const { job } = await jobsTest.advanceJob(H.db, clone(H.db.tables.extraction_jobs[0]));
    expect(job.status).toBe("completed");
    expect(orderRow().result.salesOrder.lineItems).toHaveLength(2);
    expect(H.events.some((e) => e.eventType === "quote_reconcile_failed")).toBe(true);
  });

  it("does not hold the caller past its budget", async () => {
    seed([inboundOrder({ result: { salesOrder: { lineItems: PO_LINES } } })]);
    H.delay.quotes = 200;
    const t0 = Date.now();
    const out = await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed", budgetMs: 20 });
    expect(out.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(150);
    expect(H.events.some((e) => e.eventType === "quote_reconcile_timeout")).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
  });

  it("swallows a failure that arrives after the budget ran out", async () => {
    // The run is still going when the caller moves on. If it then fails, the
    // caller is gone, and an unhandled rejection would end a Node process.
    seed([inboundOrder({ result: { salesOrder: { lineItems: PO_LINES } } })]);
    H.delay.quotes = 50;
    H.fail.quotes = "error";
    const out = await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed", budgetMs: 10 });
    expect(out.status).toBe("timeout");
    await new Promise((r) => setTimeout(r, 120));
    expect(orderRow().result.quoteReconciliation).toBeUndefined();
  });
});

describe("what the server trigger leaves alone", () => {
  it("never touches an approved order", async () => {
    seed([inboundOrder({ status: "APPROVED", result: { salesOrder: { lineItems: PO_LINES } } })]);
    const out = await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("skipped");
    expect(orderWrites()).toHaveLength(0);
  });

  it("does not overwrite a save that landed while it ran", async () => {
    seed([inboundOrder({ result: { salesOrder: { lineItems: PO_LINES } } })]);
    const newer = [{ ...PO_LINES[0], quantity: 9 }];
    // An operator save lands between the reconciler's read and its write.
    H.onRead.quotes = async () => {
      H.onRead.quotes = null;
      await H.db.from("orders").update({ result: { salesOrder: { lineItems: newer } } }).eq("tenant_id", TENANT).eq("id", ORDER);
    };
    const out = await autoReconcileOrder(H.db, { tenantId: TENANT }, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("superseded");
    expect(orderRow().result.salesOrder.lineItems).toEqual(newer);
    expect(reconAudits()).toHaveLength(0);
  });

  it("reads nothing for another tenant's order", async () => {
    const out = await autoReconcileOrder(H.db, { tenantId: OTHER_TENANT }, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("not_found");
    expect(orderWrites()).toHaveLength(0);
  });

  it("does nothing without a tenant", async () => {
    const spy = vi.spyOn(H.db, "from");
    const out = await autoReconcileOrder(H.db, {}, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });
});
