// The server's own line writes move the approval hash when they change a line
// (plan C-1).
//
// The quote reconcile fills a line's HSN from the quote, and the background
// large-PO job replaces a page-1 preview with the full line set. Neither
// wrote orders.payload_hash, so an approver who loaded the order before
// either write approved lines they had not seen. Both now move it when the
// lines changed, and leave it when they did not. When either changes an
// APPROVED order's lines, the approval is cleared in the same write, as an
// edit in the PATCH clears it.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, writes: [], ctx: null }));

// An in-memory Supabase: filters, updates and inserts apply to rows, and
// every update bumps updated_at the way the 001_init trigger does. A read
// returns only the columns it names, as PostgREST does, so a writer that
// forgets to select payload_hash or approval reads it as missing here too,
// and the tests below see what production would. A column list with a star
// or an embed returns whole rows.
const clone = (v) => JSON.parse(JSON.stringify(v));
let clock = Date.parse("2026-10-01T00:00:00Z");
const nextStamp = () => new Date((clock += 1000)).toISOString();
let seq = 0;
const PLAIN_COLUMNS = /^\s*\w+(\s*,\s*\w+)*\s*$/;

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
      let columns = null;
      const project = (r) => (columns ? Object.fromEntries(columns.map((c) => [c, c in r ? r[c] : null])) : r);
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
        return { data: clone(hit.map(project)), error: null };
      };
      const one = () => run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }));
      const api = {
        select(cols) {
          if (op !== "select") selectAfter = true;
          else if (typeof cols === "string" && PLAIN_COLUMNS.test(cols)) columns = cols.split(",").map((c) => c.trim());
          return api;
        },
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
  requirePermission: () => {},
  requireAction: () => {}, hasAction: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));

const { default: orderHandler } = await import("../api/orders/[id].js");
const { reconcileOrderQuotes, autoReconcileOrder } = await import("../api/_lib/order-reconcile.js");
const { computeOrderPayloadHash } = await import("../api/_lib/payload-hash.js");
const { __test: jobsTest } = await import("../api/cron/extraction_jobs.js");

const CTX = { tenantId: TENANT, user: { id: "u-eng" }, role: "sales_engineer" };
const MANAGER = { tenantId: TENANT, user: { id: "u-mgr" }, role: "sales_manager" };

const approve = async (payloadHash) => {
  H.ctx = MANAGER;
  const res = { setHeader() {}, end() { return res; } };
  await orderHandler({ method: "PATCH", headers: {}, query: { id: ORDER }, url: "/api/orders/" + ORDER, _body: { status: "APPROVED", approval: { payloadHash } } }, res);
  return res;
};

const QUOTE = { id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-1", created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "30 days credit" };
const QUOTE_LINES = [
  { quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, hsn_sac: "84818090", discounted_unit_price: 200 },
  { quote_id: "q1", tenant_id: TENANT, line_index: 1, part_no: "PART-B", description: "Test flange", qty: 1, hsn_sac: "84818090", discounted_unit_price: 1200 },
];
// The PO prints no HSN, so the reconcile fills it from the quote.
const LINES_NO_HSN = [
  { line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 200 },
  { line_no: 2, partNumber: "PART-B", description: "Test flange", quantity: 1, unitPrice: 1200 },
];
// The PO prints the quote's HSN, so the reconcile has nothing to fill.
const LINES_WITH_HSN = LINES_NO_HSN.map((l) => ({ ...l, hsn: "84818090" }));

// An order in review, with the hash send-for-review stamped on it.
const inReview = (lines, over = {}) => {
  const o = {
    id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "PENDING_REVIEW", po_number: "PO-TEST-1",
    quote_id: null, quote_number: null, rule_findings: [], approval: null,
    incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
    preflight_payload: {}, result: { salesOrder: { lineItems: clone(lines) } },
    ...over,
  };
  if (!("payload_hash" in over)) o.payload_hash = computeOrderPayloadHash(o);
  return o;
};

const seed = (order) => {
  H.db = makeDb({ orders: [order], quotes: [QUOTE], quote_lines: QUOTE_LINES, item_customer_parts: [], item_master: [] });
};
const row = () => H.db.tables.orders.find((o) => o.id === ORDER);
const orderWrites = () => H.writes.filter((w) => w.table === "orders");

beforeEach(() => {
  H.writes = [];
  H.ctx = CTX;
});

describe("a reconcile that changes no line", () => {
  it("does not move the hash, and the approver's hash still approves", async () => {
    seed(inReview(LINES_WITH_HSN));
    const seen = row().payload_hash;

    // The workspace's reconcile button: a forced run.
    const out = await reconcileOrderQuotes(H.db, CTX, ORDER, { trigger: "manual" });
    expect(out.status).toBe("reconciled");
    // It ran and wrote its report, and linked the quote, with no hash in the write.
    expect(row().result.quoteReconciliation.summary.matched).toBe(2);
    expect(row().quote_id).toBe("q1");
    expect(orderWrites().some((w) => "payload_hash" in w.patch)).toBe(false);
    expect(row().payload_hash).toBe(seen);

    const ok = await approve(seen);
    expect(ok._status).toBe(200);
    expect(row().status).toBe("APPROVED");
  });

  it("keeps a hash carried over from a quote", async () => {
    const QUOTE_HASH = "b".repeat(64);
    seed(inReview(LINES_WITH_HSN, { quote_id: "q1", quote_number: "Q-TEST-1", payload_hash: QUOTE_HASH }));
    await reconcileOrderQuotes(H.db, CTX, ORDER, { trigger: "manual" });
    expect(row().payload_hash).toBe(QUOTE_HASH);
  });
});

describe("a reconcile that changes a line", () => {
  it("moves the hash, so the approver who loaded the order before is refused", async () => {
    seed(inReview(LINES_NO_HSN));
    const seen = row().payload_hash;

    const out = await autoReconcileOrder(H.db, CTX, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("reconciled");
    expect(row().result.salesOrder.lineItems.map((l) => l.hsn)).toEqual(["84818090", "84818090"]);
    // The stored hash describes the order as the reconcile left it.
    expect(row().payload_hash).not.toBe(seen);
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));

    const stale = await approve(seen);
    expect(stale._status).toBe(409);
    expect(stale._json.error.code).toBe("STALE_APPROVAL");
    expect(row().status).toBe("PENDING_REVIEW");

    const ok = await approve(row().payload_hash);
    expect(ok._status).toBe(200);
  });

  it("fills the hash of an order that had none", async () => {
    seed(inReview(LINES_NO_HSN, { status: "DRAFT", payload_hash: null }));
    await autoReconcileOrder(H.db, CTX, ORDER, { trigger: "order_created" });
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));
  });
});

describe("the background writeback", () => {
  // A merged large-PO job with these lines, for the order.
  const job = (id, lines) => ({
    id, tenant_id: TENANT, order_id: ORDER, customer_id: CUSTOMER, document_id: null,
    extraction_kind: "po", status: "merging",
    chunk_status: [{ index: 0, page_start: 1, page_end: 30, page_count: 30, status: "done", attempts: 1 }],
    partial_result: { chunk_results: [{
      ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: { overall: 0.9 }, attempts: [],
      normalized: { classification: "po", customer: { name: "Test Buyer" }, lines },
    }] },
  });
  const runJob = async (j) => {
    H.db.tables.extraction_jobs = [j];
    const { job: done } = await jobsTest.advanceJob(H.db, clone(j));
    expect(done.status).toBe("completed");
  };

  it("moves the hash when it replaces the page-1 preview's lines", async () => {
    // The approver loaded the page-1 preview: one line.
    seed(inReview(LINES_WITH_HSN.slice(0, 1)));
    const seen = row().payload_hash;

    await runJob(job("job-1", LINES_WITH_HSN));
    expect(row().result.salesOrder.lineItems).toHaveLength(2);
    expect(row().payload_hash).not.toBe(seen);
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));

    const stale = await approve(seen);
    expect(stale._status).toBe(409);
    expect(stale._json.error.code).toBe("STALE_APPROVAL");
  });

  it("leaves the hash when it writes the same lines again", async () => {
    seed(inReview(LINES_WITH_HSN.slice(0, 1)));
    await runJob(job("job-1", LINES_WITH_HSN));
    const settled = row().payload_hash;
    H.writes = [];

    await runJob(job("job-2", LINES_WITH_HSN));
    expect(row().payload_hash).toBe(settled);
    expect(orderWrites().some((w) => "payload_hash" in w.patch)).toBe(false);
  });

  it("clears the approval of an approved order whose lines it replaces", async () => {
    seed(inReview(LINES_WITH_HSN.slice(0, 1)));
    approveInPlace();

    await runJob(job("job-1", LINES_WITH_HSN));
    expect(row().result.salesOrder.lineItems).toHaveLength(2);
    expect(row()).toMatchObject({ status: "APPROVED", approval: null, approval_expires_at: null, approval_actions: [] });
  });

  it("keeps the approval when it writes the lines the approver approved", async () => {
    seed(inReview(LINES_WITH_HSN.slice(0, 1)));
    await runJob(job("job-1", LINES_WITH_HSN));
    const approval = approveInPlace();

    await runJob(job("job-2", LINES_WITH_HSN));
    expect(row().approval).toEqual(approval);
    expect(row().approval_actions).toEqual(["approve", "export_tally"]);
  });
});

// An approval as the approve PATCH writes it, bound to the stored hash.
const approveInPlace = () => {
  const approval = { payloadHash: row().payload_hash, approvedBy: "u-mgr" };
  Object.assign(row(), {
    status: "APPROVED", approval,
    approval_expires_at: "2099-01-01T00:00:00.000Z", approval_actions: ["approve", "export_tally"],
  });
  return approval;
};

describe("a manual reconcile on an approved order", () => {
  it("that fills a line clears the approval, so the lines are approved again before a push", async () => {
    seed(inReview(LINES_NO_HSN));
    approveInPlace();

    const out = await reconcileOrderQuotes(H.db, CTX, ORDER, { trigger: "manual" });
    expect(out.status).toBe("reconciled");
    expect(row().result.salesOrder.lineItems.map((l) => l.hsn)).toEqual(["84818090", "84818090"]);
    expect(row().payload_hash).toBe(computeOrderPayloadHash(row()));
    // The status is the approver's to change; the approval is gone.
    expect(row()).toMatchObject({ status: "APPROVED", approval: null, approval_expires_at: null, approval_actions: [] });
    // Approved again on the order as it now stands.
    const ok = await approve(row().payload_hash);
    expect(ok._status).toBe(200);
    expect(row().approval.payloadHash).toBe(row().payload_hash);
  });

  it("that changes nothing keeps the approval", async () => {
    seed(inReview(LINES_WITH_HSN));
    const approval = approveInPlace();

    const out = await reconcileOrderQuotes(H.db, CTX, ORDER, { trigger: "manual" });
    expect(out.status).toBe("reconciled");
    expect(row().approval).toEqual(approval);
    expect(orderWrites().some((w) => "approval" in w.patch)).toBe(false);
  });
});
