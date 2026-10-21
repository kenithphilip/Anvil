// The drift check re-queues a voucher that Tally does not have.
//
// applyAutoFix("missing_in_tally") used to insert into tally_retry_queue with
// columns the table does not have (tally_voucher_record_id, attempt, reason)
// and without the NOT NULL voucher_type, payload_xml and payload_hash. The
// insert always failed, but the finding still said "re_pushed", so nothing
// was ever re-pushed. Now the row is built the way the copilot enqueue builds
// it, and a row that is not in the queue is reported as "re_push_failed".
//
// Each test drives the real driftCheck, the real enqueue and the real voucher
// builder against an in-memory Supabase stand-in. The stand-in refuses a
// tally_retry_queue row the way PostgREST and Postgres do: an unknown column
// or a missing NOT NULL value is an error. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { driftCheck } from "../api/_lib/tally-reconciler.js";

// tally_retry_queue, as created in supabase/migrations/016_tally_v2.sql.
const QUEUE_COLUMNS = new Set([
  "id", "tenant_id", "company_id", "order_id", "voucher_record_id", "voucher_type",
  "payload_xml", "payload_hash", "attempt_count", "max_attempts", "last_attempt_at",
  "next_attempt_at", "last_error", "status", "created_at", "updated_at",
]);
const QUEUE_NOT_NULL = ["tenant_id", "voucher_type", "payload_xml", "payload_hash"];

let store;
let seq;
let fail; // { table, op }: that statement returns a database error

const refusal = (table, row) => {
  if (table !== "tally_retry_queue") return null;
  const unknown = Object.keys(row).find((c) => !QUEUE_COLUMNS.has(c));
  if (unknown) return { code: "PGRST204", message: "Could not find the '" + unknown + "' column of 'tally_retry_queue' in the schema cache" };
  const missing = QUEUE_NOT_NULL.find((c) => row[c] == null);
  if (missing) return { code: "23502", message: "null value in column \"" + missing + "\" violates not-null constraint" };
  return null;
};

const from = (table) => {
  const st = { op: "select", payload: null, filters: [], limit: Infinity, cols: null };
  const rows = () => (store[table] = store[table] || []);
  const run = () => {
    if (fail && fail.table === table && fail.op === st.op) {
      return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    if (st.op === "insert") {
      const items = Array.isArray(st.payload) ? st.payload : [st.payload];
      for (const it of items) {
        const bad = refusal(table, it);
        if (bad) return { error: bad };
      }
      const out = items.map((it) => ({ id: table + "-" + (++seq), ...it }));
      rows().push(...out);
      return { out };
    }
    const matched = rows().filter((r) => st.filters.every((f) => f(r))).slice(0, st.limit);
    if (st.op === "update") for (const r of matched) Object.assign(r, st.payload);
    return { out: matched };
  };
  // Like PostgREST, a row comes back with the selected columns only.
  const pick = (r) => (st.cols ? Object.fromEntries(st.cols.map((c) => [c, r[c]])) : r);
  const settle = (mode) => {
    const { out: all, error } = run();
    if (error) return Promise.resolve({ data: null, error });
    const out = all.map(pick);
    if (mode === "many") return Promise.resolve({ data: out, error: null });
    if (out.length > 1 || (mode === "single" && out.length === 0)) {
      return Promise.resolve({ data: null, error: { code: "PGRST116", message: "expected one row, got " + out.length } });
    }
    return Promise.resolve({ data: out[0] || null, error: null });
  };
  const q = {
    select(cols) { if (cols && cols !== "*") st.cols = cols.split(",").map((c) => c.trim()); return q; },
    insert(p) { st.op = "insert"; st.payload = p; return q; },
    update(p) { st.op = "update"; st.payload = p; return q; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
    gte(c, v) { st.filters.push((r) => r[c] >= v); return q; },
    order() { return q; },
    limit(n) { st.limit = n; return q; },
    single() { return settle("single"); },
    maybeSingle() { return settle("maybe"); },
    then(res, rej) { return settle("many").then(res, rej); },
  };
  return q;
};
const svc = { from };

const TENANT = "t-1";
const OTHER = "t-2";

const order = (over = {}) => ({
  id: "o-1",
  tenant_id: TENANT,
  status: "EXPORTED_TO_TALLY",
  po_number: "PO-100",
  customer_id: null,
  approval: { payloadHash: "h-approved" },
  payload_hash: "h-current",
  result: { salesOrder: { lineItems: [{ tallyItemName: "Item A", qty: 2, rate: 50, gst_pct: 18 }] } },
  ...over,
});

const seed = (orders) => {
  store = {
    orders,
    tally_companies: [
      { id: "co-0", tenant_id: TENANT, name: "Company Zero", is_default: true, bridge_url: "https://bridge-0.test", state_code: "29" },
      { id: "co-1", tenant_id: TENANT, name: "Company One", is_default: false, bridge_url: "https://bridge-1.test", state_code: "27" },
    ],
    tally_voucher_records: [{
      id: "vr-1", tenant_id: TENANT, order_id: "o-1", company_id: "co-1",
      voucher_no: "SV-0042", voucher_type: "Sales", status: "exported", payload_hash: "h-current",
    }],
  };
};

const check = () => driftCheck(svc, { tenantId: TENANT, scope: "order", scopeValue: "o-1", autoFix: true });
const queue = () => store.tally_retry_queue || [];
const finding = (i = 0) => (store.tally_reconciliation_findings || [])[i];
const lastRun = () => store.tally_reconciliation_runs.at(-1);

beforeEach(() => {
  seq = 0;
  fail = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("drift check: a voucher missing in Tally", () => {
  it("queues the voucher with the columns the retry drain reads", async () => {
    seed([order()]);
    const out = await check();

    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({
      tenant_id: TENANT,
      company_id: "co-1",
      order_id: "o-1",
      voucher_record_id: "vr-1",
      voucher_type: "Sales",
      payload_hash: "h-current",
      attempt_count: 0,
      status: "pending",
    });
    // The number the voucher was pushed under, not one derived from the PO.
    expect(queue()[0].payload_xml).toContain("<VOUCHERNUMBER>SV-0042</VOUCHERNUMBER>");
    expect(finding()).toMatchObject({ finding_kind: "missing_in_tally", auto_fix_applied: "re_pushed" });
    expect(out.auto_fixes_applied).toBe(1);
    expect(lastRun().auto_fixes_applied).toBe(1);
  });

  it("takes the approval hash when the order has no payload hash", async () => {
    seed([order({ payload_hash: null })]);
    await check();
    expect(queue()[0].payload_hash).toBe("h-approved");
  });

  it("reports a failed insert as re_push_failed, not re_pushed", async () => {
    seed([order()]);
    fail = { table: "tally_retry_queue", op: "insert" };
    const out = await check();

    expect(queue()).toHaveLength(0);
    expect(finding()).toMatchObject({ finding_kind: "missing_in_tally", auto_fix_applied: "re_push_failed" });
    expect(out.auto_fixes_applied).toBe(0);
  });

  it("does not queue when it cannot read the queue for an earlier re-push", async () => {
    seed([order()]);
    fail = { table: "tally_retry_queue", op: "select" };
    await check();
    expect(queue()).toHaveLength(0);
    expect(finding().auto_fix_applied).toBe("re_push_failed");
  });

  it("does not queue an order that is not approved", async () => {
    seed([order({ approval: null })]);
    await check();
    expect(queue()).toHaveLength(0);
    expect(finding().auto_fix_applied).toBe("re_push_failed");
  });

  it("does not queue a cancelled order", async () => {
    seed([order({ status: "CANCELLED" })]);
    await check();
    expect(queue()).toHaveLength(0);
    expect(finding().auto_fix_applied).toBe("re_push_failed");
  });

  it("does not read an order that belongs to another tenant", async () => {
    seed([order({ tenant_id: OTHER })]);
    await check();
    expect(queue()).toHaveLength(0);
    expect(finding().auto_fix_applied).toBe("re_push_failed");
  });

  it("records the finding when the voucher cannot be built", async () => {
    seed([order({ result: { salesOrder: { lineItems: [{ qty: 1, rate: 10 }] } } })]);
    const out = await check();
    expect(queue()).toHaveLength(0);
    expect(finding()).toMatchObject({ finding_kind: "missing_in_tally", auto_fix_applied: "re_push_failed" });
    expect(out.status).toBe("ok");
  });

  it("queues one automatic re-push per voucher record", async () => {
    seed([order()]);
    await check();
    const second = await check();

    expect(queue()).toHaveLength(1);
    expect(finding(1).finding_kind).toBe("missing_in_tally");
    expect(finding(1).auto_fix_applied).toBeUndefined();
    expect(second.auto_fixes_applied).toBe(0);
  });
});
