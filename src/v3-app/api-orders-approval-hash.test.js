// The approval hash moves on every line write, quote-priced or not (plan C-1).
//
// orders/[id].js stopped recomputing orders.payload_hash once an order had a
// quote_id, and the reconcile writes quote_id on every scanned PO that
// matches a quote. So an engineer's edit after the approver loaded a
// quote-priced order left the hash where it was, and the approver's stale
// view passed the STALE_APPROVAL check from #605. The hash now moves on every
// content edit. A write that changes nothing still leaves it, so the
// approver's own approve goes through when the order is what they saw.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, audits: [], writes: [], ctx: null }));

// An in-memory Supabase: filters, updates and inserts apply to rows, and
// every update bumps updated_at the way the 001_init trigger does.
const clone = (v) => JSON.parse(JSON.stringify(v));
let clock = Date.parse("2026-10-01T00:00:00Z");
const nextStamp = () => new Date((clock += 1000)).toISOString();
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
      const run = async () => {
        const rows = tables[table] || (tables[table] = []);
        if (op === "insert") {
          const out = rowsIn.map((r) => ({ id: r.id || "row-" + (++seq), created_at: nextStamp(), updated_at: nextStamp(), ...clone(r) }));
          rows.push(...out);
          return { data: clone(out), error: null };
        }
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
  resolveContext: async () => H.ctx,
  // Roles are not under test here; api-approve-stale-hash.test.js checks
  // that an engineer cannot approve.
  requirePermission: () => {},
  requireAction: () => {}, hasAction: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (_ctx, p) => { H.audits.push(p); },
  recordEvent: async () => {},
}));
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));

const { default: orderHandler } = await import("../api/orders/[id].js");
const { computeOrderPayloadHash } = await import("../api/_lib/payload-hash.js");

const ENGINEER = { tenantId: TENANT, user: { id: "u-eng" }, role: "sales_engineer" };
const MANAGER = { tenantId: TENANT, user: { id: "u-mgr" }, role: "sales_manager" };

const call = async (ctx, req) => {
  H.ctx = ctx;
  const res = { setHeader() {}, end() { return res; } };
  await orderHandler({ headers: {}, query: { id: ORDER }, url: "/api/orders/" + ORDER, ...req }, res);
  return res;
};
const save = (body) => call(ENGINEER, { method: "PATCH", _body: body });
const load = async () => (await call(MANAGER, { method: "GET" }))._json.order;
const approve = (payloadHash) => call(MANAGER, { method: "PATCH", _body: { status: "APPROVED", approval: { payloadHash } } });

// The PO prints the HSN the quote carries, so the reconcile fills nothing on
// these lines: every hash move below comes from the edit under test.
const PO_LINES = [
  { line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 200, hsn: "84818090" },
  { line_no: 2, partNumber: "PART-B", description: "Test flange", quantity: 1, unitPrice: 1200, hsn: "84818090" },
];
const QUOTE = { id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-1", created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "30 days credit" };
const QUOTE_LINES = [
  { quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, hsn_sac: "84818090", discounted_unit_price: 200 },
  { quote_id: "q1", tenant_id: TENANT, line_index: 1, part_no: "PART-B", description: "Test flange", qty: 1, hsn_sac: "84818090", discounted_unit_price: 1200 },
];

const baseOrder = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "DRAFT", po_number: "PO-TEST-1",
  quote_id: null, quote_number: null, rule_findings: [], approval: null, payload_hash: null,
  incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
  preflight_payload: {}, result: {},
  ...over,
});

const seed = (order) => {
  H.db = makeDb({ orders: [order], quotes: [QUOTE], quote_lines: QUOTE_LINES, item_customer_parts: [], item_master: [] });
};
const row = () => H.db.tables.orders.find((o) => o.id === ORDER);
const withQty = (result, qty) => {
  const next = clone(result);
  next.salesOrder.lineItems[0].quantity = qty;
  return next;
};

// A scanned PO the reconcile priced from a quote, sent for review.
const quotePricedInReview = async () => {
  seed(baseOrder());
  await save({ result: { salesOrder: { lineItems: PO_LINES } } });
  // The reconcile linked the quote, which is what used to stop the hash.
  expect(row().quote_id).toBe("q1");
  await save({ status: "PENDING_REVIEW" });
  expect(row().status).toBe("PENDING_REVIEW");
};

beforeEach(() => {
  H.audits = []; H.writes = [];
});

describe("a quote-priced order", () => {
  it("edited after the approver loaded it is refused with 409 STALE_APPROVAL", async () => {
    await quotePricedInReview();
    const seen = await load();
    expect(seen.payload_hash).toBeTruthy();

    // The engineer changes a quantity after the approver opened the order.
    await save({ result: withQty(row().result, 9) });
    expect(row().payload_hash).not.toBe(seen.payload_hash);
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));

    const stale = await approve(seen.payload_hash);
    expect(stale._status).toBe(409);
    expect(stale._json.error.code).toBe("STALE_APPROVAL");
    expect(row().status).toBe("PENDING_REVIEW");
    expect(row().approval).toBeNull();
    expect(H.audits.map((a) => a.action)).not.toContain("approve_order");

    // Reloaded, the approver approves what is there now.
    const fresh = await load();
    const ok = await approve(fresh.payload_hash);
    expect(ok._status).toBe(200);
    expect(row().status).toBe("APPROVED");
  });

  it("left unchanged approves with the hash the approver loaded", async () => {
    await quotePricedInReview();
    const seen = await load();

    // A save of the same lines, as the workspace does on reload, is not an edit.
    await save({ result: clone(row().result) });
    expect(row().payload_hash).toBe(seen.payload_hash);

    const ok = await approve(seen.payload_hash);
    expect(ok._status).toBe(200);
    expect(row().status).toBe("APPROVED");
    expect(row().approval.payloadHash).toBe(seen.payload_hash);
    expect(row().approved_by).toBe("u-mgr");
    // The approve itself does not move the hash.
    expect(row().payload_hash).toBe(seen.payload_hash);
  });
});

describe("an order converted from a quote", () => {
  // quotes/convert.js carries the quote's own hash onto the order. It covers
  // a different object, so it is not computeOrderPayloadHash of the order.
  const QUOTE_HASH = "a".repeat(64);
  const converted = () => baseOrder({
    quote_id: "q1", quote_number: "Q-TEST-1", payload_hash: QUOTE_HASH,
    result: { salesOrder: { lineItems: clone(PO_LINES) } },
  });

  it("keeps the quote's hash through send-for-review and approves with it", async () => {
    seed(converted());
    await save({ status: "PENDING_REVIEW" });
    const seen = await load();
    expect(seen.payload_hash).toBe(QUOTE_HASH);
    const ok = await approve(QUOTE_HASH);
    expect(ok._status).toBe(200);
    expect(row().status).toBe("APPROVED");
  });

  it("moves off the quote's hash at the first line edit, and the stale view is refused", async () => {
    seed(converted());
    await save({ status: "PENDING_REVIEW" });
    const seen = await load();
    await save({ result: withQty(row().result, 7) });
    expect(row().payload_hash).not.toBe(QUOTE_HASH);
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));
    const stale = await approve(seen.payload_hash);
    expect(stale._status).toBe(409);
    expect(stale._json.error.code).toBe("STALE_APPROVAL");
    expect(row().status).toBe("PENDING_REVIEW");
  });
});
