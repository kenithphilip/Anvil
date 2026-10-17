// "Mark reconciled" (POST /api/tally/reconcile, mode "mark") writes values
// the database accepts.
//
// markStatus used to write orders.status = TALLY_RECONCILED (and
// TALLY_IMPORTED for "imported"). Neither is an order_status value, so
// Postgres refused the whole update and the button always failed. The old
// endpoint test mocked markStatus, so nothing caught it.
//
// Now tally_status takes the operator's value, and orders.status moves only
// from EXPORTED_TO_TALLY (a voucher Anvil pushed, Mode A). A Mode B order
// stays APPROVED. Each test drives the real markStatus, or the real handler,
// against an in-memory Supabase stand-in that enforces the same constraints
// as the database: the order_status enum and the tally_status CHECK.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

// order_status, as created in supabase/migrations/001_init.sql.
const ORDER_STATUS = new Set([
  "DRAFT", "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE",
  "REUSED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED", "CANCELLED",
]);
// orders.tally_status CHECK, from supabase/migrations/005_close_remaining_gaps.sql.
const TALLY_STATUS = new Set(["idle", "pending", "dry_run_ok", "exported", "imported", "failed", "reconciled"]);

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

// A Postgres refusal for a value the column cannot hold, or null when the
// row is valid.
const violation = (table, row) => {
  if (table !== "orders") return null;
  if ("status" in row && !ORDER_STATUS.has(row.status)) {
    return row.status == null
      ? { code: "23502", message: "null value in column \"status\" violates not-null constraint" }
      : { code: "22P02", message: "invalid input value for enum order_status: \"" + row.status + "\"" };
  }
  if ("tally_status" in row && row.tally_status != null && !TALLY_STATUS.has(row.tally_status)) {
    return { code: "23514", message: "new row for relation \"orders\" violates check constraint \"orders_tally_status_check\"" };
  }
  return null;
};

const from = (table) => {
  const st = { op: "select", payload: null, filters: [] };
  const rows = () => (H.store[table] = H.store[table] || []);
  const hit = (r) => st.filters.every((f) => f(r));
  const run = () => {
    const store = rows();
    if (st.op === "insert") {
      const items = Array.isArray(st.payload) ? st.payload : [st.payload];
      const out = items.map((it) => ({ id: table + "-" + (++H.seq), ...it }));
      store.push(...out);
      return { out };
    }
    const matched = store.filter(hit);
    if (st.op === "update") {
      // Postgres checks the whole statement before it writes any row.
      for (const r of matched) {
        const bad = violation(table, { ...r, ...st.payload });
        if (bad) return { error: bad };
      }
      for (const r of matched) Object.assign(r, st.payload);
    }
    return { out: matched };
  };
  const settle = (mode) => {
    const { out, error } = run();
    if (error) return Promise.resolve({ data: null, error });
    if (mode === "many") return Promise.resolve({ data: out, error: null });
    if (out.length > 1 || (mode === "single" && out.length === 0)) {
      return Promise.resolve({ data: null, error: { code: "PGRST116", message: "expected one row, got " + out.length } });
    }
    return Promise.resolve({ data: out[0] || null, error: null });
  };
  const q = {
    select() { return q; },
    insert(p) { st.op = "insert"; st.payload = p; return q; },
    update(p) { st.op = "update"; st.payload = p; return q; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
    single() { return settle("single"); },
    maybeSingle() { return settle("maybe"); },
    then(res, rej) { return settle("many").then(res, rej); },
  };
  return q;
};
const svc = { from };

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({ from }),
  userClient: () => { throw new Error("userClient is not used in these tests"); },
}));
vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, resolveContext: async (req) => req._ctx };
});
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));

const { markStatus } = await import("../api/_lib/tally-reconciler.js");
const { default: tallyReconcile } = await import("../api/tally/reconcile.js");

const TENANT = "t-1";
const OTHER = "t-2";
const table = (name) => H.store[name] || [];
const order = (id, status, tenant = TENANT) => ({ id, tenant_id: tenant, status, tally_status: "exported" });

const call = async (handler, { method = "POST", url = "/api/tally/reconcile", body = {}, ctx } = {}) => {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method, url, headers: {}, query: {}, body, _ctx: ctx }, res);
  const isJson = String(res.headers["content-type"] || "").includes("application/json");
  return { status: res.statusCode, body: isJson ? JSON.parse(res.body) : res.body };
};
const approver = { user: { id: "u-1" }, tenantId: TENANT, role: "admin", anonymous: false };

beforeEach(() => {
  H.store = {};
  H.seq = 0;
});

describe("markStatus writes a valid status", () => {
  it("reconciles a pushed (Mode A) order to RECONCILED, and the write succeeds", async () => {
    H.store.orders = [order("o-1", "EXPORTED_TO_TALLY")];
    H.store.tally_voucher_records = [{ id: "vr-1", tenant_id: TENANT, order_id: "o-1", status: "exported", tally_voucher_id: null }];
    const out = await markStatus(svc, {
      tenantId: TENANT, orderId: "o-1", status: "reconciled", tallyVoucherId: "TV-9", triggeredBy: "u-1",
    });
    expect(out.order).toMatchObject({ id: "o-1", status: "RECONCILED", tally_status: "reconciled" });
    expect(table("orders")[0]).toMatchObject({ status: "RECONCILED", tally_status: "reconciled" });
    expect(table("tally_voucher_records")[0]).toMatchObject({ tally_voucher_id: "TV-9", status: "exported" });
    expect(table("tally_reconciliation_runs")).toHaveLength(1);
    expect(table("tally_reconciliation_runs")[0]).toMatchObject({
      tenant_id: TENANT, trigger: "manual", scope: "order", scope_value: "o-1",
      vouchers_clean: 1, vouchers_drifted: 0, triggered_by: "u-1", status: "ok",
    });
  });

  it("marks a pushed order failed as FAILED_TALLY_IMPORT", async () => {
    H.store.orders = [order("o-1", "EXPORTED_TO_TALLY")];
    const out = await markStatus(svc, { tenantId: TENANT, orderId: "o-1", status: "failed", triggeredBy: "u-1" });
    expect(out.order).toMatchObject({ status: "FAILED_TALLY_IMPORT", tally_status: "failed" });
    expect(table("tally_reconciliation_runs")[0]).toMatchObject({ vouchers_clean: 0, vouchers_drifted: 1 });
  });

  it("keeps a Mode B order APPROVED and records the Tally state on tally_status", async () => {
    H.store.orders = [order("o-1", "APPROVED")];
    const out = await markStatus(svc, { tenantId: TENANT, orderId: "o-1", status: "reconciled", triggeredBy: "u-1" });
    expect(out.order).toMatchObject({ status: "APPROVED", tally_status: "reconciled" });
    expect(table("orders")[0]).toMatchObject({ status: "APPROVED", tally_status: "reconciled" });
  });

  it("records 'imported' on tally_status without changing the order status", async () => {
    H.store.orders = [order("o-1", "APPROVED"), order("o-2", "EXPORTED_TO_TALLY")];
    await markStatus(svc, { tenantId: TENANT, orderId: "o-1", status: "imported", triggeredBy: "u-1" });
    await markStatus(svc, { tenantId: TENANT, orderId: "o-2", status: "imported", triggeredBy: "u-1" });
    expect(table("orders")[0]).toMatchObject({ status: "APPROVED", tally_status: "imported" });
    expect(table("orders")[1]).toMatchObject({ status: "EXPORTED_TO_TALLY", tally_status: "imported" });
  });

  it.each([
    ["EXPORTED_TO_TALLY"], ["APPROVED"], ["FAILED_TALLY_IMPORT"], ["RECONCILED"], ["CANCELLED"],
  ])("every mark on a %s order succeeds and leaves an enum status", async (start) => {
    for (const status of ["reconciled", "failed", "imported"]) {
      H.store.orders = [order("o-1", start)];
      const out = await markStatus(svc, { tenantId: TENANT, orderId: "o-1", status, triggeredBy: "u-1" });
      expect(ORDER_STATUS.has(out.order.status)).toBe(true);
      expect(out.order.tally_status).toBe(status);
    }
  });

  it("refuses another tenant's order with a 404 and writes nothing", async () => {
    H.store.orders = [order("o-1", "EXPORTED_TO_TALLY", OTHER)];
    await expect(markStatus(svc, { tenantId: TENANT, orderId: "o-1", status: "reconciled", triggeredBy: "u-1" }))
      .rejects.toMatchObject({ status: 404 });
    expect(table("orders")[0]).toMatchObject({ status: "EXPORTED_TO_TALLY", tally_status: "exported" });
    expect(table("tally_reconciliation_runs")).toHaveLength(0);
  });
});

describe("POST /api/tally/reconcile mode=mark, through the real markStatus", () => {
  it("the Mark reconciled button's request reconciles the order", async () => {
    H.store.orders = [order("o-1", "EXPORTED_TO_TALLY")];
    const out = await call(tallyReconcile, {
      body: { orderId: "o-1", status: "reconciled", tally_voucher_id: null }, ctx: approver,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ mode: "mark", order: { id: "o-1", status: "RECONCILED", tally_status: "reconciled" } });
    expect(table("orders")[0]).toMatchObject({ status: "RECONCILED", tally_status: "reconciled" });
  });

  it("answers 404 for another tenant's order instead of failing the request", async () => {
    H.store.orders = [order("o-1", "EXPORTED_TO_TALLY", OTHER)];
    const out = await call(tallyReconcile, { body: { mode: "mark", orderId: "o-1", status: "reconciled" }, ctx: approver });
    expect(out.status).toBe(404);
    expect(out.body.error.message).toBe("Order not found");
    expect(table("orders")[0]).toMatchObject({ status: "EXPORTED_TO_TALLY" });
    expect(table("tally_reconciliation_runs")).toHaveLength(0);
  });
});
