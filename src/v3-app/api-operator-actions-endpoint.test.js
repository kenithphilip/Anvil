// Integration test for the operator-actions endpoints (PR4): flag gate,
// create + steps, advance (state machine), and reconcile - note (write)
// vs guarded order-status (approve, behind requireApprovedOrder).

import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "tenant-1";
const U1 = "user-1";

let tables;
let ctxState;
let flagState;

const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select";
    let patch = null;
    let single = false;
    let countMode = false;
    const b = {
      select: (_c, opts) => { if (opts && (opts.count || opts.head)) countMode = true; return b; },
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      order: () => b,
      limit: () => b,
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      insert: (row) => { mode = "insert"; patch = row; return b; },
      update: (p) => { mode = "update"; patch = p; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "insert") {
        const arr = (Array.isArray(patch) ? patch : [patch]).map((r) => ({ id: r.id || (table + "-" + (ds.length + 1)), ...r }));
        ds.push(...arr);
        return { data: single ? arr[0] : arr, error: null };
      }
      if (mode === "update") {
        for (const r of rows) Object.assign(r, patch);
        return { data: single ? rows[0] || null : rows, error: null };
      }
      if (countMode) return { count: rows.length, data: null, error: null };
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ctxState,
  requirePermission: (ctx, level) => {
    const rank = { read: 0, write: 1, approve: 2, admin: 3 };
    if (rank[ctx.role] < rank[level]) { const e = new Error("forbidden " + level); e.status = 403; throw e; }
  },
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({ operator_actions_enabled: flagState }) }));

import createHandler from "../api/operator_actions/index.js";
import advanceHandler from "../api/operator_actions/advance.js";
import reconcileHandler from "../api/operator_actions/reconcile.js";

const call = async (handler, method, body, query) => {
  const req = { method, query: query || {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler(req, res);
  return res;
};

beforeEach(() => {
  tables = {};
  ctxState = { tenantId: T1, role: "approve" === "approve" ? "sales_manager" : "x", user: { id: U1 } };
  // role with approve: use 'admin' to satisfy both write + approve in the mock
  ctxState.role = "admin";
  flagState = true;
});

describe("operator_actions feature gate", () => {
  it("returns 409 FEATURE_DISABLED when the flag is off", async () => {
    flagState = false;
    const r = await call(createHandler, "POST", { title: "x" });
    expect(r._status).toBe(409);
    expect(r._json.error.code).toBe("FEATURE_DISABLED");
  });
});

describe("create + advance", () => {
  it("creates an action with steps (proposed) and advances to in_progress", async () => {
    const c = await call(createHandler, "POST", { title: "Key into legacy SAP", steps: [{ instruction: "Open GUI" }, { instruction: "Enter SO" }], requires_evidence: false });
    expect(c._status).toBe(201);
    expect(c._json.action.status).toBe("proposed");
    expect(c._json.step_count).toBe(2);
    expect(tables.operator_action_steps).toHaveLength(2);

    const id = c._json.action.id;
    const a = await call(advanceHandler, "POST", { id, event: "start" });
    expect(a._status).toBe(200);
    expect(a._json.action.status).toBe("in_progress");
    expect(tables.operator_actions[0].status).toBe("in_progress");
  });

  it("rejects an illegal transition", async () => {
    const c = await call(createHandler, "POST", { title: "x", requires_evidence: false });
    const id = c._json.action.id;
    // attach_evidence from 'proposed' is illegal (must start first)
    const a = await call(advanceHandler, "POST", { id, event: "attach_evidence" });
    expect(a._status).toBe(409);
    expect(a._json.error.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("reconcile - note", () => {
  it("reconciles with a note (no SOR mutation) and marks reconciled", async () => {
    const c = await call(createHandler, "POST", { title: "Downloaded report", requires_evidence: false, object_type: "order", object_id: "ord-1", reconcile_contract: { type: "note", text: "Saved GST report" } });
    const id = c._json.action.id;
    await call(advanceHandler, "POST", { id, event: "start" });
    const r = await call(reconcileHandler, "POST", { id });
    expect(r._status).toBe(200);
    expect(r._json.result.type).toBe("note");
    expect(tables.operator_actions[0].status).toBe("reconciled");
  });
});

describe("reconcile - guarded order status", () => {
  const statusContract = { type: "status", target: { object_type: "order", object_id: "ord-9" }, set: { field: "status", value: "APPROVED" } };

  it("blocks when the target order is not approved", async () => {
    tables.orders = [{ id: "ord-9", tenant_id: T1, status: "DRAFT" }]; // no approval
    const c = await call(createHandler, "POST", { title: "Approve in console", requires_evidence: false, reconcile_contract: statusContract });
    const id = c._json.action.id;
    await call(advanceHandler, "POST", { id, event: "start" });
    const r = await call(reconcileHandler, "POST", { id });
    expect(r._status).toBe(409);
    expect(r._json.error.code).toBe("ORDER_NOT_APPROVED");
    expect(tables.orders[0].status).toBe("DRAFT"); // unchanged
  });

  it("applies the status when the order is approved + hash matches", async () => {
    tables.orders = [{ id: "ord-9", tenant_id: T1, status: "PENDING_REVIEW", approval: { payloadHash: "h1" }, payload_hash: "h1" }];
    const c = await call(createHandler, "POST", { title: "Approve in console", requires_evidence: false, reconcile_contract: statusContract });
    const id = c._json.action.id;
    await call(advanceHandler, "POST", { id, event: "start" });
    const r = await call(reconcileHandler, "POST", { id, payload_hash: "h1" });
    expect(r._status).toBe(200);
    expect(r._json.result).toMatchObject({ type: "status", order_id: "ord-9", status: "APPROVED" });
    expect(tables.orders[0].status).toBe("APPROVED");
  });

  it("requires evidence before reconcile when requires_evidence is true", async () => {
    const c = await call(createHandler, "POST", { title: "x", requires_evidence: true, reconcile_contract: { type: "note", text: "hi" }, object_id: "o1" });
    const id = c._json.action.id;
    await call(advanceHandler, "POST", { id, event: "start" });
    const r = await call(reconcileHandler, "POST", { id });
    expect(r._status).toBe(409);
    expect(r._json.error.message).toMatch(/evidence required/);
  });
});
