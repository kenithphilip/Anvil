// Fixing an order's customer, PO number and PO date (plan PR 7).
//
// None of the three was on the PATCH allowlist, so a wrong auto-match meant
// cancel and redo, and an inbound order created with no customer could never
// get one. They are now allowed while the order is DRAFT or PENDING_REVIEW and
// refused after. A new customer must be this tenant's; it re-runs the item
// map and the quote reconcile; and every change is audited.
//
// These tests run the REAL orders/[id].js and the REAL reconcile over an
// in-memory database. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "00000000-0000-0000-0000-0000000000aa";
const OTHER_T = "00000000-0000-0000-0000-0000000000ff";
const C1 = "00000000-0000-0000-0000-0000000000c1";
const C2 = "00000000-0000-0000-0000-0000000000c2";
const C_OTHER = "00000000-0000-0000-0000-0000000000c9";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({
  db: null, audits: [], events: [], writes: [], mapCalls: [],
  ctx: { tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-eng" }, role: "sales_engineer" },
  // The item map each customer's own part codes give: customer -> part -> item.
  partMaps: {},
}));

const clone = (v) => JSON.parse(JSON.stringify(v));
let clock = Date.parse("2026-10-01T00:00:00Z");
const nextStamp = () => new Date((clock += 1000)).toISOString();

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
          const out = rowsIn.map((r, i) => ({ id: "row-" + i + "-" + nextStamp(), created_at: nextStamp(), ...clone(r) }));
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
        insert(r) { op = "insert"; rowsIn = Array.isArray(r) ? r : [r]; return api; },
        maybeSingle: one,
        single: one,
        then: (f, r) => run().then(f, r),
      };
      return api;
    },
  };
};

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db }));
vi.mock("../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveContext: async () => H.ctx,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push({ tenantId: ctx?.tenantId, ...p }); },
  recordEvent: async (ctx, p) => { H.events.push({ tenantId: ctx?.tenantId, ...p }); },
}));
// The item map, by each customer's own part codes. Its tiers are tested in
// their own suites; here it stands for "what the new customer's codes say".
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, tenantId, customerId, lines) => {
    H.mapCalls.push({ tenantId, customerId });
    const m = H.partMaps[customerId] || {};
    return lines.map((l) => ({ ...l, _mapped_item: m[l.partNumber] ? { id: m[l.partNumber], match_via: "customer_part" } : null }));
  },
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));

const { default: patchOrder } = await import("../api/orders/[id].js");
const { computeOrderPayloadHash } = await import("../api/_lib/payload-hash.js");

const call = async (body, id = ORDER) => {
  const res = { _status: 200, _json: null, setHeader() {}, status(c) { res._status = c; return res; }, send(p) { res._json = JSON.parse(p); return res; }, json(o) { res._json = o; return res; }, end() { return res; } };
  await patchOrder({ method: "PATCH", headers: {}, query: { id }, url: "/api/orders/" + id, body }, res);
  return res;
};

const LINES = [
  { line_no: 1, partNumber: "BUYER-A", description: "Test bracket", quantity: 4, unitPrice: 250 },
  { line_no: 2, partNumber: "BUYER-B", description: "Test flange", quantity: 1, unitPrice: 1200,
    _mapped_item: { id: "item-hand", match_via: "manual" } },
];

const order = (over = {}) => ({
  id: ORDER, tenant_id: T, customer_id: C1, status: "DRAFT", po_number: "PO-OLD-1", po_date: "2026-09-01",
  quote_id: "q-c1", quote_number: "Q-C1-1", opportunity_id: null, rule_findings: [], approval: null,
  payload_hash: "hash-before", updated_at: "2026-09-30T00:00:00.000Z",
  preflight_payload: { source_document_id: "doc-1" },
  result: { salesOrder: { lineItems: clone(LINES) }, quoteReconciliation: { trigger: "order_created", quotes_used: [{ quote_id: "q-c1", quote_number: "Q-C1-1" }] } },
  ...over,
});

const seed = (orders = [order()]) => {
  H.db = makeDb({
    orders,
    customers: [
      { id: C1, tenant_id: T, customer_name: "Wrong Buyer Pvt Ltd", country: "IN" },
      { id: C2, tenant_id: T, customer_name: "Right Buyer Pvt Ltd", country: "IN" },
      { id: C_OTHER, tenant_id: OTHER_T, customer_name: "Another Tenant's Buyer", country: "IN" },
    ],
    quotes: [
      { id: "q-c1", tenant_id: T, customer_id: C1, quote_number: "Q-C1-1", created_at: "2026-08-01T00:00:00Z", status: "SENT", terms: "30 days" },
      { id: "q-c2", tenant_id: T, customer_id: C2, quote_number: "Q-C2-1", created_at: "2026-08-02T00:00:00Z", status: "SENT", terms: "30 days" },
    ],
    quote_lines: [
      { quote_id: "q-c1", tenant_id: T, line_index: 0, part_no: "BUYER-A", qty: 4, discounted_unit_price: 999 },
      { quote_id: "q-c2", tenant_id: T, line_index: 0, part_no: "BUYER-A", qty: 4, discounted_unit_price: 250 },
      { quote_id: "q-c2", tenant_id: T, line_index: 1, part_no: "BUYER-B", qty: 1, discounted_unit_price: 1200 },
    ],
    item_customer_parts: [],
    item_master: [],
  });
};

const row = () => H.db.tables.orders.find((o) => o.id === ORDER);
const orderWrites = () => H.writes.filter((w) => w.table === "orders");
const identityAudits = () => H.audits.filter((a) => a.action === "order_identity_changed");

beforeEach(() => {
  H.audits = []; H.events = []; H.writes = []; H.mapCalls = [];
  H.ctx = { tenantId: T, user: { id: "u-eng" }, role: "sales_engineer" };
  H.partMaps = { [C2]: { "BUYER-A": "item-c2-a", "BUYER-B": "item-c2-b" } };
  seed();
});

describe("allowed while the order is DRAFT or PENDING_REVIEW", () => {
  it("changes the customer, PO number and PO date of a DRAFT, and audits each field", async () => {
    const res = await call({ customer_id: C2, po_number: " PO-NEW-7 ", po_date: "2026-09-30", reason: "Matched the wrong buyer" });
    expect(res._status).toBe(200);
    expect(row()).toMatchObject({ customer_id: C2, po_number: "PO-NEW-7", po_date: "2026-09-30" });
    const audit = identityAudits()[0];
    expect(audit).toMatchObject({
      objectId: ORDER,
      reason: "Matched the wrong buyer",
      before: { customer_id: C1, po_number: "PO-OLD-1", po_date: "2026-09-01" },
      after: { customer_id: C2, po_number: "PO-NEW-7", po_date: "2026-09-30" },
    });
    expect(audit.detail.changes.customer_id).toEqual({ from: C1, to: C2 });
    expect(H.events.some((e) => e.eventType === "order_identity_changed")).toBe(true);
  });

  it("changes them on a PENDING_REVIEW order, and an approval of the old view is then stale", async () => {
    // The stored hash is the real one for this order, so nothing but the
    // customer can move it.
    const pending = order({ status: "PENDING_REVIEW", quote_id: null, quote_number: null });
    pending.payload_hash = computeOrderPayloadHash(pending);
    seed([pending]);
    const before = row().payload_hash;
    const res = await call({ customer_id: C2 });
    expect(res._status).toBe(200);
    expect(row().status).toBe("PENDING_REVIEW");
    // The hash covers the customer, so it moved.
    expect(row().payload_hash).not.toBe(before);
    expect(row().payload_hash).toBe(computeOrderPayloadHash({ ...pending, customer_id: C2 }));
    H.ctx = { tenantId: T, user: { id: "u-mgr" }, role: "sales_manager" };
    const stale = await call({ status: "APPROVED", approval: { payloadHash: before } });
    expect(stale._status).toBe(409);
    expect(stale._json.error.code).toBe("STALE_APPROVAL");
    const fresh = await call({ status: "APPROVED", approval: { payloadHash: row().payload_hash } });
    expect(fresh._status).toBe(200);
  });

  it("records the basis: chosen by a person, who, and the customer it replaced", async () => {
    await call({ customer_id: C2 });
    expect(row().preflight_payload.customer_match).toMatchObject({
      customer_id: C2, basis: "operator", by: "u-eng", previous_customer_id: C1,
    });
    // The rest of the payload is kept.
    expect(row().preflight_payload.source_document_id).toBe("doc-1");
  });

  it("assigns a customer to an order that came in with none", async () => {
    seed([order({ customer_id: null, quote_id: null, quote_number: null })]);
    const res = await call({ customer_id: C2 });
    expect(res._status).toBe(200);
    expect(row().customer_id).toBe(C2);
    expect(row().result.quoteReconciliation.quotes_used.map((q) => q.quote_number)).toEqual(["Q-C2-1"]);
  });

  it("writes nothing and audits nothing when the values are the ones it has", async () => {
    const res = await call({ customer_id: C1, po_number: "PO-OLD-1", po_date: "2026-09-01" });
    expect(res._status).toBe(200);
    expect(identityAudits()).toHaveLength(0);
    expect(H.mapCalls).toHaveLength(0);
  });
});

describe("a customer change re-runs the item map and the reconcile", () => {
  it("maps the lines by the new customer's part codes, keeping a hand-made map", async () => {
    await call({ customer_id: C2 });
    expect(H.mapCalls).toEqual([{ tenantId: T, customerId: C2 }]);
    const lines = row().result.salesOrder.lineItems;
    expect(lines[0]._mapped_item).toMatchObject({ id: "item-c2-a", match_via: "customer_part" });
    // The operator mapped line 2 by hand; that stands.
    expect(lines[1]._mapped_item).toEqual({ id: "item-hand", match_via: "manual" });
  });

  it("reconciles against the new customer's quotes and links its quote", async () => {
    await call({ customer_id: C2 });
    const recon = row().result.quoteReconciliation;
    expect(recon.trigger).toBe("customer_changed");
    expect(recon.quotes_used.map((q) => q.quote_number)).toEqual(["Q-C2-1"]);
    expect(recon.summary).toMatchObject({ total: 2, matched: 2, price_mismatch: 0 });
    expect(row().quote_number).toBe("Q-C2-1");
    expect(identityAudits()[0].detail.unlinked).toEqual(["quote"]);
  });

  it("unlinks the old customer's quote even when the new one has none", async () => {
    H.db.tables.quotes = H.db.tables.quotes.filter((q) => q.customer_id !== C2);
    await call({ customer_id: C2 });
    expect(row().quote_id).toBeNull();
    expect(row().quote_number).toBeNull();
  });

  it("does not re-map or reconcile for a PO number or date change alone", async () => {
    const writes = orderWrites().length;
    await call({ po_number: "PO-FIXED" });
    expect(H.mapCalls).toHaveLength(0);
    expect(orderWrites().length).toBe(writes + 1);
    expect(row().quote_id).toBe("q-c1");
  });
});

describe("refused", () => {
  it("after APPROVED, with nothing written", async () => {
    seed([order({ status: "APPROVED" })]);
    const res = await call({ customer_id: C2 });
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("IDENTITY_LOCKED");
    expect(orderWrites()).toHaveLength(0);
    expect(row().customer_id).toBe(C1);
  });

  it("in every status other than DRAFT and PENDING_REVIEW", async () => {
    for (const status of ["EXPORTED_TO_TALLY", "RECONCILED", "CANCELLED", "BLOCKED"]) {
      seed([order({ status })]);
      const res = await call({ po_number: "PO-X" });
      expect(res._status).toBe(409);
      expect(orderWrites()).toHaveLength(0);
    }
  });

  it("in the same PATCH that approves", async () => {
    seed([order({ status: "PENDING_REVIEW" })]);
    H.ctx = { tenantId: T, user: { id: "u-mgr" }, role: "sales_manager" };
    const res = await call({ status: "APPROVED", approval: { payloadHash: "hash-before" }, po_number: "PO-SNEAK" });
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("IDENTITY_LOCKED");
    expect(row().status).toBe("PENDING_REVIEW");
  });

  it("for another tenant's customer, with nothing written", async () => {
    const res = await call({ customer_id: C_OTHER });
    expect(res._status).toBe(404);
    expect(res._json.error.code).toBe("CUSTOMER_NOT_FOUND");
    expect(orderWrites()).toHaveLength(0);
    expect(row().customer_id).toBe(C1);
  });

  it("for a customer that does not exist, or none at all", async () => {
    expect((await call({ customer_id: "00000000-0000-0000-0000-00000000dead" }))._status).toBe(404);
    expect((await call({ customer_id: null }))._status).toBe(400);
    expect(orderWrites()).toHaveLength(0);
  });

  it("for a PO date that is not a date", async () => {
    const res = await call({ po_date: "2026-02-31" });
    expect(res._status).toBe(400);
    expect(res._json.error.code).toBe("INVALID_PO_DATE");
    expect(orderWrites()).toHaveLength(0);
  });

  it("for a role that cannot write", async () => {
    H.ctx = { tenantId: T, user: { id: "u-view" }, role: "viewer" };
    const res = await call({ customer_id: C2 });
    expect(res._status).toBe(403);
    expect(orderWrites()).toHaveLength(0);
  });
});

describe("a PO date in a local format", () => {
  it("is read with the customer's country and stored as a day", async () => {
    const res = await call({ po_date: "30/09/2026" });
    expect(res._status).toBe(200);
    expect(row().po_date).toBe("2026-09-30");
  });
});
