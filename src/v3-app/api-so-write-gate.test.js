// The server checks so.write, so.cancel and so.admin on the sales-order write
// endpoints (auth.js SERVER_ACTIONS). Before, only the coarse "write" verb was
// checked, and it admits procurement, finance and operator, whom the MATRIX
// keeps read-only on sales orders.
//
// The real auth.js runs here (only resolveContext is replaced, to pick the
// role). An approver's decision (approve, return for fix, clear a blocker)
// stays open to finance, which approves orders but does not write them.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, role: "sales_engineer", audits: [] }));

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// A small in-memory Supabase for the orders table; every other table reads
// empty and writes nothing.
const makeDb = (rows) => ({
  rows,
  from(table) {
    const filters = [];
    let patch = null;
    const run = async () => {
      const list = table === "orders" ? rows : [];
      const hit = list.filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of hit) Object.assign(r, clone(patch));
      return { data: clone(hit), error: null, count: 0 };
    };
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
      in() { return api; },
      order() { return api; },
      limit() { return api; },
      update(p) { patch = p; return api; },
      insert() { return api; },
      delete() { return api; },
      single: () => run().then((r) => ({ data: r.data[0] || null, error: r.data[0] ? null : { message: "not found" } })),
      maybeSingle: () => run().then((r) => ({ data: r.data[0] || null, error: null })),
      then: (f, rj) => run().then(f, rj),
    };
    return api;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db, userClient: () => ({}) }));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message, code: err.code } }; return res; },
}));
vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-1" }, role: H.role, anonymous: false }),
  };
});
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push(p); },
  recordEvent: async () => {},
}));
vi.mock("../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: async () => ({ created: [] }) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));
vi.mock("../api/_lib/item-mapper.js", () => ({ lineCandidates: () => [], lineSapCandidates: () => [] }));
vi.mock("../api/_lib/item-customer-parts.js", () => ({ upsertCustomerPart: async () => ({}) }));
vi.mock("../api/_lib/order-reconcile.js", () => ({
  autoReconcileOrder: async () => {}, hasReconcilableLines: () => false, AUTO_RECONCILE_STATUSES: new Set(),
  reconcileOrderQuotes: async () => ({ ok: true }),
}));

const { default: patchOrder } = await import("../api/orders/[id].js");
const { default: reconcileQuotes } = await import("../api/orders/reconcile_quotes.js");
const { default: termsCheck } = await import("../api/orders/terms_check.js");
const { default: attachQuote } = await import("../api/orders/attach_quote.js");
const { default: detachQuote } = await import("../api/orders/detach_quote.js");
const { default: extractionJobs } = await import("../api/orders/extraction_jobs.js");
const { default: scheduleLines } = await import("../api/orders/schedule_lines.js");

const order = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, status: "DRAFT", po_number: "PO-GATE-1", quote_id: null,
  payload_hash: "hash-gate-1", approval: null, approval_expires_at: null, approval_actions: [],
  rule_findings: [], result: {}, preflight_payload: {},
  ...over,
});

const call = async (handler, { method = "POST", body = {}, query = {} } = {}) => {
  const res = { setHeader() {}, end() { return res; } };
  await handler({ method, headers: {}, query: { id: ORDER, ...query }, url: "/api/orders/" + ORDER, _body: body }, res);
  return res;
};
const as = (role) => { H.role = role; };
const seed = (over) => { H.db = makeDb([order(over)]); };

beforeEach(() => { H.audits = []; seed(); });

describe("PATCH /api/orders/[id]: an edit needs so.write", () => {
  const edit = { committed_delivery_date: "2026-11-30" };

  it.each(["sales_engineer", "sales_manager", "design_engineer", "admin"])("%s may edit", async (role) => {
    as(role);
    const res = await call(patchOrder, { method: "PATCH", body: edit });
    expect(res._status).toBe(200);
    expect(H.db.rows[0].committed_delivery_date).toBe("2026-11-30");
  });

  it.each(["finance", "procurement", "operator"])("%s may not (a coarse writer, read-only on sales orders)", async (role) => {
    as(role);
    const res = await call(patchOrder, { method: "PATCH", body: edit });
    expect(res._status).toBe(403);
    expect(res._json.error.code).toBe("ACTION_FORBIDDEN");
    expect(H.db.rows[0].committed_delivery_date).toBeUndefined();
  });

  it("send for approval is a write too", async () => {
    as("finance");
    expect((await call(patchOrder, { method: "PATCH", body: { status: "PENDING_REVIEW" } }))._status).toBe(403);
    as("sales_engineer");
    expect((await call(patchOrder, { method: "PATCH", body: { status: "PENDING_REVIEW" } }))._status).toBe(200);
    expect(H.db.rows[0].status).toBe("PENDING_REVIEW");
  });
});

describe("PATCH /api/orders/[id]: an approver's decision stays open to finance", () => {
  it("finance approves", async () => {
    seed({ status: "PENDING_REVIEW" });
    as("finance");
    const res = await call(patchOrder, { method: "PATCH", body: { status: "APPROVED", approval: { payloadHash: "hash-gate-1" } } });
    expect(res._status).toBe(200);
    expect(H.db.rows[0].status).toBe("APPROVED");
  });

  it("a key the handler never writes does not turn a decision into an edit", async () => {
    seed({ status: "PENDING_REVIEW" });
    as("finance");
    const res = await call(patchOrder, { method: "PATCH", body: { status: "APPROVED", approval: { payloadHash: "hash-gate-1" }, note_for_queue: "x" } });
    expect(res._status).toBe(200);
  });

  it("an approval that also edits the order needs so.write", async () => {
    seed({ status: "PENDING_REVIEW" });
    as("finance");
    const res = await call(patchOrder, { method: "PATCH", body: { status: "APPROVED", approval: { payloadHash: "hash-gate-1" }, committed_delivery_date: "2026-12-01" } });
    expect(res._status).toBe(403);
    expect(H.db.rows[0].status).toBe("PENDING_REVIEW");
  });

  it("finance returns an order for a fix; procurement may not", async () => {
    seed({ status: "PENDING_REVIEW" });
    as("procurement");
    const body = { status: "DRAFT", correction_reason: "Rate on line 1 is wrong", correction_requested_by: "finance" };
    expect((await call(patchOrder, { method: "PATCH", body }))._status).toBe(403);
    as("finance");
    expect((await call(patchOrder, { method: "PATCH", body }))._status).toBe(200);
    expect(H.db.rows[0].status).toBe("DRAFT");
  });

  it("finance clears a blocking finding", async () => {
    seed({ status: "PENDING_REVIEW", rule_findings: [{ code: "line_count_shortfall", blocks: true }] });
    as("finance");
    const res = await call(patchOrder, { method: "PATCH", body: { resolve_finding: { code: "line_count_shortfall", note: "checked" } } });
    expect(res._status).toBe(200);
  });
});

describe("PATCH /api/orders/[id]: the customer, PO number and PO date are edits", () => {
  it("a sales engineer may fix the PO number", async () => {
    as("sales_engineer");
    const res = await call(patchOrder, { method: "PATCH", body: { po_number: "PO-GATE-2" } });
    expect(res._status).toBe(200);
    expect(H.db.rows[0].po_number).toBe("PO-GATE-2");
  });

  it("finance may not, on its own or inside an approval", async () => {
    seed({ status: "PENDING_REVIEW" });
    as("finance");
    expect((await call(patchOrder, { method: "PATCH", body: { po_number: "PO-GATE-2" } }))._status).toBe(403);
    const res = await call(patchOrder, { method: "PATCH", body: { status: "APPROVED", approval: { payloadHash: "hash-gate-1" }, po_number: "PO-GATE-2" } });
    expect(res._status).toBe(403);
    expect(H.db.rows[0].po_number).toBe("PO-GATE-1");
    expect(H.db.rows[0].status).toBe("PENDING_REVIEW");
  });
});

describe("PATCH /api/orders/[id]: a cancel needs so.cancel", () => {
  it.each(["sales_engineer", "finance", "design_manager"])("%s may not cancel", async (role) => {
    as(role);
    const res = await call(patchOrder, { method: "PATCH", body: { status: "CANCELLED", reason: "Customer withdrew it" } });
    expect(res._status).toBe(403);
    expect(H.db.rows[0].status).toBe("DRAFT");
  });

  it.each(["sales_manager", "admin"])("%s may cancel", async (role) => {
    as(role);
    const res = await call(patchOrder, { method: "PATCH", body: { status: "CANCELLED", reason: "Customer withdrew it" } });
    expect(res._status).toBe(200);
    expect(H.db.rows[0].status).toBe("CANCELLED");
  });
});

describe("the order write endpoints the SO workspace calls need so.write", () => {
  const ENDPOINTS = [
    ["reconcile_quotes", reconcileQuotes],
    ["terms_check", termsCheck],
    ["attach_quote", attachQuote],
    ["detach_quote", detachQuote],
    ["extraction_jobs POST", extractionJobs],
    ["schedule_lines POST", scheduleLines],
  ];

  it.each(ENDPOINTS)("%s refuses finance", async (_name, handler) => {
    as("finance");
    const res = await call(handler, { body: {} });
    expect(res._status).toBe(403);
    expect(res._json.error.code).toBe("ACTION_FORBIDDEN");
  });

  it.each(ENDPOINTS)("%s lets a sales engineer through (to its own input check)", async (_name, handler) => {
    as("sales_engineer");
    const res = await call(handler, { body: {} });
    expect(res._status).toBe(400);
  });
});

describe("deleting schedule lines needs so.admin", () => {
  it("refuses a sales manager", async () => {
    as("sales_manager");
    const res = await call(scheduleLines, { method: "DELETE", query: { id: "sl-1" } });
    expect(res._status).toBe(403);
  });

  it("lets an admin delete", async () => {
    as("admin");
    const res = await call(scheduleLines, { method: "DELETE", query: { id: "sl-1" } });
    expect(res._status).toBe(200);
    expect(H.audits.map((a) => a.action)).toContain("schedule_line_delete");
  });
});
