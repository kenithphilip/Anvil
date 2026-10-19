// The background writeback never changes reviewed lines (plan C-2).
//
// A large PO is extracted by a background job. Its page-1 lines can be
// reviewed, approved and even pushed before the job ends. The job used to
// replace every line then, with the operator's edits and item mappings, and
// nothing recorded it. Now it writes lines only to a DRAFT. On a reviewed
// order it holds the new lines on a blocking finding, and an order in review
// or approved goes back to DRAFT with the reason (C-D1). A cancelled order is
// never written to. The order write is compare-and-set, so a save or a cancel
// that lands while the job works is not overwritten, and a job cancel is not
// overwritten by the next stage.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, writes: [], audits: [], afterRead: {}, ctx: null }));

// An in-memory Supabase: filters, updates and inserts apply to rows, every
// update bumps updated_at as the 001_init trigger does, and a read returns
// only the columns it names. afterRead[table] runs after a read of that table
// returns, so a test can land a save between the job's read and its write.
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
        const data = clone(hit.map(project));
        if (H.afterRead[table]) await H.afterRead[table]();
        return { data, error: null };
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
        or() { return api; },
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
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push({ tenantId: ctx?.tenantId, ...p }); },
  recordEvent: async () => {},
}));
// The item master maps every part: a mapped line carries _mapped_item.
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines.map((l) => ({ ...l, _mapped_item: { item_id: "im-" + l.partNumber, match_via: "part_no" } })),
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));

const { __test: jobsTest } = await import("../api/cron/extraction_jobs.js");
const { default: orderHandler } = await import("../api/orders/[id].js");
const { default: jobHandler } = await import("../api/orders/extraction_jobs_id.js");
const { computeOrderPayloadHash } = await import("../api/_lib/payload-hash.js");
const { buildOrderExceptions } = await import("../api/_lib/order-exceptions.js");

const CTX = { tenantId: TENANT, user: { id: "u-eng" }, role: "sales_engineer" };

// The page-1 preview the operator reviewed: one line, with an edit (the rate)
// and the item mapping they chose.
const REVIEWED = [{ line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 190, _mapped_item: { item_id: "im-op", match_via: "operator" } }];
// What the full document holds.
const FULL = [
  { line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 200 },
  { line_no: 2, partNumber: "PART-B", description: "Test flange", quantity: 1, unitPrice: 1200 },
];

const orderAt = (status, over = {}) => {
  const o = {
    id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status, po_number: "PO-TEST-1",
    quote_id: null, quote_number: null, rule_findings: [], approval: null, approval_expires_at: null, approval_actions: [],
    incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
    correction_reason: null, preflight_payload: {}, result: { salesOrder: { customer: { name: "Test Buyer" }, lineItems: clone(REVIEWED) } },
    ...over,
  };
  o.payload_hash = computeOrderPayloadHash(o);
  return o;
};
const approvedAt = (status) => orderAt(status, {
  approval: { payloadHash: "h-approved", approvedBy: "u-mgr" },
  approval_expires_at: "2099-01-01T00:00:00.000Z", approval_actions: ["approve", "export_tally"],
});

const mergingJob = (lines = FULL) => ({
  id: "job-1", tenant_id: TENANT, order_id: ORDER, customer_id: CUSTOMER, document_id: null,
  extraction_kind: "po", status: "merging",
  chunk_status: [{ index: 0, page_start: 1, page_end: 30, page_count: 30, status: "done", attempts: 1 }],
  partial_result: { chunk_results: [{
    ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: { overall: 0.9 }, attempts: [],
    normalized: { classification: "po", customer: { name: "Test Buyer" }, lines },
  }] },
});

const seed = (order, job = mergingJob()) => {
  H.db = makeDb({ orders: [order], extraction_jobs: [job], quotes: [], quote_lines: [], item_customer_parts: [], item_master: [] });
};
const row = () => H.db.tables.orders.find((o) => o.id === ORDER);
const jobRow = () => H.db.tables.extraction_jobs.find((j) => j.id === "job-1");
const orderWrites = () => H.writes.filter((w) => w.table === "orders");
const runJob = () => jobsTest.advanceJob(H.db, clone(jobRow()));
const held = () => (row().rule_findings || []).find((f) => f.code === "lines_changed_after_review");
const exceptionRow = () => buildOrderExceptions({ order: row() }).rows.find((r) => r.type === "lines_changed_after_review");
const reviewedLinesKept = () => {
  expect(row().result.salesOrder.lineItems).toEqual(REVIEWED);
};

beforeEach(() => {
  H.writes = []; H.audits = []; H.afterRead = {};
  H.ctx = CTX;
});

describe("a DRAFT order", () => {
  it("gets the full lines, mapped to the item master, and the job completes", async () => {
    seed(orderAt("DRAFT"));
    const { job } = await runJob();
    expect(job.status).toBe("completed");
    const lines = row().result.salesOrder.lineItems;
    expect(lines.map((l) => [l.partNumber, l.unitPrice])).toEqual([["PART-A", 200], ["PART-B", 1200]]);
    expect(lines.map((l) => l._mapped_item?.item_id)).toEqual(["im-PART-A", "im-PART-B"]);
    expect(row().status).toBe("DRAFT");
    expect(held()).toBeUndefined();
  });
});

describe("an order in review", () => {
  it("keeps its reviewed lines, goes back to DRAFT with the reason, and holds the new lines on a blocking finding", async () => {
    seed(orderAt("PENDING_REVIEW"));
    const { job } = await runJob();
    expect(job.status).toBe("completed");
    reviewedLinesKept();
    expect(row().status).toBe("DRAFT");
    expect(row().correction_reason).toMatch(/full extraction finished while the order was pending review/);
    expect(row().correction_requested_by).toBe("background extraction");

    const f = held();
    expect(f).toMatchObject({ blocks: true, resolved: false, source: "extraction", from_status: "PENDING_REVIEW", extraction_job_id: "job-1" });
    // The held lines are the job's, mapped, so nothing it read is lost.
    expect(f.pending_lines.map((l) => [l.partNumber, l.unitPrice, l._mapped_item.item_id])).toEqual([["PART-A", 200, "im-PART-A"], ["PART-B", 1200, "im-PART-B"]]);

    // The exceptions list shows it, and it blocks approval.
    expect(exceptionRow()).toMatchObject({ blocks: "approval", status: "open", payload: { pending_line_count: 2, current_line_count: 1 } });
    expect(H.audits.find((a) => a.action === "order_lines_held_after_review")).toMatchObject({ objectId: ORDER, after: { from_status: "PENDING_REVIEW", line_count: 2, kept_count: 1 } });
  });

  it("cannot be approved until an approver resolves the finding", async () => {
    seed(orderAt("PENDING_REVIEW"));
    await runJob();
    row().status = "PENDING_REVIEW"; // sent for review again
    const res = { setHeader() {}, end() { return res; } };
    await orderHandler({ method: "PATCH", headers: {}, query: { id: ORDER }, url: "/api/orders/" + ORDER, _body: { status: "APPROVED", approval: { payloadHash: row().payload_hash } } }, res);
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("ORDER_HAS_UNRESOLVED_BLOCKER");
    expect(row().status).toBe("PENDING_REVIEW");
  });

  it("is left alone when the full extraction read the same lines", async () => {
    seed(orderAt("PENDING_REVIEW"), mergingJob(REVIEWED.map(({ _mapped_item, ...l }) => l)));
    const { job } = await runJob();
    expect(job.status).toBe("completed");
    expect(orderWrites()).toHaveLength(0);
    expect(row().status).toBe("PENDING_REVIEW");
  });
});

describe("an APPROVED order", () => {
  it("keeps its lines, loses its approval, goes back to DRAFT, and raises the row", async () => {
    seed(approvedAt("APPROVED"));
    await runJob();
    reviewedLinesKept();
    expect(row()).toMatchObject({ status: "DRAFT", approval: null, approval_expires_at: null, approval_actions: [] });
    expect(exceptionRow()).toMatchObject({ blocks: "approval", status: "open" });
  });
});

describe("an order past approval", () => {
  it("EXPORTED_TO_TALLY keeps its lines, status and approval, and raises the row", async () => {
    seed(approvedAt("EXPORTED_TO_TALLY"));
    await runJob();
    reviewedLinesKept();
    expect(row()).toMatchObject({ status: "EXPORTED_TO_TALLY", approval: { payloadHash: "h-approved" }, approval_actions: ["approve", "export_tally"], correction_reason: null });
    expect(held()).toMatchObject({ from_status: "EXPORTED_TO_TALLY", blocks: true });
    expect(exceptionRow()).toMatchObject({ blocks: "approval" });
  });

  it("a second late job replaces the open held lines, never adds a second finding", async () => {
    seed(approvedAt("EXPORTED_TO_TALLY"));
    await runJob();
    H.db.tables.extraction_jobs = [{ ...mergingJob([...FULL, { line_no: 3, partNumber: "PART-C", quantity: 2, unitPrice: 50 }]), id: "job-1" }];
    await runJob();
    const open = row().rule_findings.filter((f) => f.code === "lines_changed_after_review");
    expect(open).toHaveLength(1);
    expect(open[0].pending_lines).toHaveLength(3);
  });
});

describe("a CANCELLED order", () => {
  it("is never written to, and the job completes with its result", async () => {
    seed(orderAt("CANCELLED"));
    const { job } = await runJob();
    expect(job.status).toBe("completed");
    expect(orderWrites()).toHaveLength(0);
    expect(jobRow().result.normalized.lines).toHaveLength(2);
  });
});

describe("a change that lands while the job writes", () => {
  it("an operator cancel between the read and the write is not overwritten", async () => {
    seed(orderAt("PENDING_REVIEW"));
    H.afterRead.orders = async () => {
      H.afterRead.orders = null;
      await H.db.from("orders").update({ status: "CANCELLED" }).eq("tenant_id", TENANT).eq("id", ORDER);
    };
    const { job } = await runJob();
    expect(job.status).toBe("completed");
    expect(row().status).toBe("CANCELLED");
    reviewedLinesKept();
    expect(held()).toBeUndefined();
  });

  it("a send for review between the read and the write: the lines are held, not written", async () => {
    seed(orderAt("DRAFT"));
    H.afterRead.orders = async () => {
      H.afterRead.orders = null;
      await H.db.from("orders").update({ status: "PENDING_REVIEW" }).eq("tenant_id", TENANT).eq("id", ORDER);
    };
    await runJob();
    reviewedLinesKept();
    expect(row().status).toBe("DRAFT");
    expect(held().from_status).toBe("PENDING_REVIEW");
  });

  it("an order that changes on both tries fails the job visibly and keeps the result on the job", async () => {
    seed(orderAt("DRAFT"));
    H.afterRead.orders = async () => {
      await H.db.from("orders").update({ line_edits: [{ at: nextStamp() }] }).eq("tenant_id", TENANT).eq("id", ORDER);
    };
    const { job } = await runJob();
    H.afterRead.orders = null;
    expect(job.status).toBe("failed");
    expect(jobRow()).toMatchObject({ status: "failed", last_error: expect.stringMatching(/changed twice/) });
    expect(jobRow().result.normalized.lines).toHaveLength(2);
    reviewedLinesKept();
  });
});

describe("an operator cancel of the job", () => {
  it("that lands while a chunk runs is kept: the next stage does not overwrite it", async () => {
    // The tick read the job while it was extracting; the cancel landed after.
    seed(orderAt("DRAFT"), { ...mergingJob(), status: "extracting" });
    const ticked = clone(jobRow());
    jobRow().status = "cancelled";
    const out = await jobsTest.advanceJob(H.db, ticked);
    expect(out.hasMore).toBe(false);
    expect(jobRow().status).toBe("cancelled");
    expect(orderWrites()).toHaveLength(0);
  });

  const cancel = async () => {
    const res = { setHeader() {}, end() { return res; } };
    await jobHandler({ method: "PATCH", headers: {}, query: { id: "job-1" }, url: "/api/orders/extraction_jobs/job-1", _body: { action: "cancel" } }, res);
    return res;
  };

  it("is refused once the job is merging, since it is writing the order", async () => {
    seed(orderAt("DRAFT"));
    const res = await cancel();
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("JOB_WRITING");
    expect(jobRow().status).toBe("merging");
  });

  it("is refused when the worker moves the job on after the cancel read it", async () => {
    seed(orderAt("DRAFT"), { ...mergingJob(), status: "extracting" });
    H.afterRead.extraction_jobs = async () => {
      H.afterRead.extraction_jobs = null;
      jobRow().status = "merging";
    };
    const res = await cancel();
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("JOB_MOVED");
    expect(jobRow().status).toBe("merging");
  });

  it("cancels a job that is still extracting", async () => {
    seed(orderAt("DRAFT"), { ...mergingJob(), status: "extracting" });
    const res = await cancel();
    expect(res._status).toBe(200);
    expect(jobRow().status).toBe("cancelled");
  });
});
