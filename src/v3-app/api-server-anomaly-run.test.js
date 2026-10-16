// The server runs the anomaly rules (plan PR 8, audit F7).
//
// The rule library ran only when someone clicked "run validation", so an
// order nobody clicked on reached the approver unscored, and #600's
// exceptions list said "Anomaly check not run". autoReconcileOrder now runs
// the same library at its end, before approval only, once per payload hash,
// within a budget, and never at the cost of the save.
//
// These tests run the REAL orders/index.js, orders/[id].js, reconcile and
// rule library over an in-memory database. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "00000000-0000-0000-0000-0000000000aa";
const OTHER_T = "00000000-0000-0000-0000-0000000000ff";
const C1 = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({
  db: null, audits: [], events: [], writes: [],
  ctx: { tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-eng" }, role: "sales_engineer" },
  // (table, cols) -> "error" | "throw" | number (delay in ms) | undefined
  onSelect: null,
  onRead: null,
}));

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
      let cols = "";
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
        if (op === "select") {
          const rule = H.onSelect ? H.onSelect(table, cols) : undefined;
          if (typeof rule === "number") await new Promise((r) => setTimeout(r, rule));
          if (rule === "error") return { data: null, error: { message: table + " unavailable" } };
          if (rule === "throw") throw new Error(table + " exploded");
          if (H.onRead && H.onRead[table]) await H.onRead[table]();
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
        select(c) { if (op !== "select") selectAfter = true; else cols = c || ""; return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        neq(c, v) { filters.push((r) => String(r[c]) !== String(v)); return api; },
        in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return api; },
        not(c, op2, v) {
          if (op2 === "is") { filters.push((r) => r[c] != null); return api; }
          const banned = String(v).replace(/[()]/g, "").split(",");
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
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));

const { default: createOrder } = await import("../api/orders/index.js");
const { default: patchOrder } = await import("../api/orders/[id].js");
const { autoReconcileOrder } = await import("../api/_lib/order-reconcile.js");
const { autoAnomalyCheck, runOrderAnomalyCheck } = await import("../api/_lib/order-anomaly-check.js");
const { buildOrderExceptions } = await import("../api/_lib/order-exceptions.js");
const { computeOrderPayloadHash } = await import("../api/_lib/payload-hash.js");

const call = async (handler, req) => {
  const res = { _status: 200, _json: null, setHeader() {}, status(c) { res._status = c; return res; }, send(p) { res._json = JSON.parse(p); return res; }, json(o) { res._json = o; return res; }, end() { return res; } };
  await handler({ headers: {}, query: {}, url: "/api/orders", ...req }, res);
  return res;
};

// Two lines the duplicate_line rule flags: same item, unit and rate.
const LINES = [
  { line_no: 1, itemName: "TEST-BRACKET", partNumber: "TEST-BRACKET", description: "Test bracket", uom: "NOS", quantity: 4, qty: 4, unitPrice: 250, rate: 250 },
  { line_no: 2, itemName: "TEST-BRACKET", partNumber: "TEST-BRACKET", description: "Test bracket", uom: "NOS", quantity: 4, qty: 4, unitPrice: 250, rate: 250 },
];

const order = (over = {}) => ({
  id: ORDER, tenant_id: T, customer_id: C1, status: "DRAFT", po_number: "PO-ANOM-1",
  quote_id: null, quote_number: null, approval: null, payload_hash: null, updated_at: "2026-09-30T00:00:00.000Z",
  rule_findings: [], preflight_payload: { source_document_id: "doc-1" },
  result: { salesOrder: { lineItems: clone(LINES) } },
  ...over,
});

const seed = (orders = []) => {
  H.db = makeDb({
    orders,
    customers: [{ id: C1, tenant_id: T, customer_name: "Test Buyer", state_code: "27" }],
    quotes: [], quote_lines: [], item_customer_parts: [], item_master: [], part_aliases: [],
  });
};

const row = (id = ORDER) => H.db.tables.orders.find((o) => o.id === id);
const ruleKeys = (r) => (r.rule_findings || []).filter((f) => f.key).map((f) => f.key);
const orderWrites = () => H.writes.filter((w) => w.table === "orders");
const notRunRow = (o) => buildOrderExceptions({ order: o }).rows.find((x) => x.type === "anomaly_check_not_run");
const HISTORY = "result, created_at";

beforeEach(() => {
  H.audits = []; H.events = []; H.writes = []; H.onSelect = null; H.onRead = null;
  H.ctx = { tenantId: T, user: { id: "u-eng" }, role: "sales_engineer" };
  seed();
});

describe("the server scores an order without a click", () => {
  it("create yields rule_findings and stamps the run", async () => {
    const res = await call(createOrder, { method: "POST", body: { customer_id: C1, po_number: "PO-ANOM-2", result: { salesOrder: { lineItems: LINES } } } });
    expect(res._status).toBe(201);
    const r = row(res._json.order.id);
    expect(ruleKeys(r)).toContain("duplicate_line");
    expect(r.preflight_payload.last_validated_at).toBeTruthy();
    expect(r.preflight_payload.rules_evaluated).toBeGreaterThan(0);
    expect(r.preflight_payload.anomaly_check).toMatchObject({
      payload_hash: computeOrderPayloadHash(r), customer_id: C1, trigger: "order_created", cost_rules: true,
    });
  });

  it("#600's 'Anomaly check not run' row is gone once the server has run the checks", async () => {
    const res = await call(createOrder, { method: "POST", body: { customer_id: C1, po_number: "PO-ANOM-3", result: { salesOrder: { lineItems: LINES } } } });
    // The row as inserted, before the server's run: the row is there.
    expect(notRunRow(res._json.order)).toBeTruthy();
    // The row as the server left it: the row is gone, and the rule hit is a row.
    const after = row(res._json.order.id);
    expect(notRunRow(after)).toBeUndefined();
    expect(buildOrderExceptions({ order: after }).rows.map((x) => x.type)).toContain("anomaly:duplicate_line");
  });

  it("runs when lines land on an order through the workspace", async () => {
    seed([order({ result: {} })]);
    const res = await call(patchOrder, { method: "PATCH", query: { id: ORDER }, body: { result: { salesOrder: { lineItems: LINES } } } });
    expect(res._status).toBe(200);
    expect(ruleKeys(row())).toContain("duplicate_line");
    expect(row().preflight_payload.anomaly_check.trigger).toBe("lines_changed");
  });
});

describe("once per payload hash", () => {
  it("a second trigger on the same payload writes nothing", async () => {
    seed([order()]);
    const first = await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    expect(first.anomaly_check).toBe("checked");
    const at = row().preflight_payload.anomaly_check.at;
    const writes = orderWrites().length;
    const again = await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    expect(again.anomaly_check).toBe("unchanged");
    expect(orderWrites()).toHaveLength(writes);
    expect(row().preflight_payload.anomaly_check.at).toBe(at);
  });

  it("runs again when a line changes, and drops a flag that no longer holds", async () => {
    seed([order()]);
    await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    expect(ruleKeys(row())).toContain("duplicate_line");
    const edited = clone(row().result);
    edited.salesOrder.lineItems[1] = { ...edited.salesOrder.lineItems[1], itemName: "TEST-FLANGE", partNumber: "TEST-FLANGE", rate: 900, unitPrice: 900 };
    await call(patchOrder, { method: "PATCH", query: { id: ORDER }, body: { result: edited } });
    expect(ruleKeys(row())).not.toContain("duplicate_line");
    expect(row().preflight_payload.anomaly_check.payload_hash).toBe(computeOrderPayloadHash(row()));
  });

  it("checks an order the reconcile already settled before this shipped", async () => {
    seed([order()]);
    await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    // Forget the check, as on an order reconciled before plan PR 8.
    const r = row();
    delete r.preflight_payload.anomaly_check;
    delete r.preflight_payload.last_validated_at;
    r.rule_findings = [];
    const out = await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("unchanged");
    expect(out.anomaly_check).toBe("checked");
    expect(ruleKeys(row())).toContain("duplicate_line");
  });
});

describe("before approval only", () => {
  it("is skipped on an APPROVED order, which keeps its findings", async () => {
    seed([order({ status: "APPROVED", rule_findings: [{ key: "old_flag", label: "Old" }] })]);
    const out = await runOrderAnomalyCheck(H.db, H.ctx, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("skipped");
    expect(orderWrites()).toHaveLength(0);
    expect(row().rule_findings).toEqual([{ key: "old_flag", label: "Old" }]);
    expect((await autoReconcileOrder(H.db, H.ctx, ORDER, { trigger: "lines_changed" })).status).toBe("skipped");
    expect(orderWrites()).toHaveLength(0);
  });

  it("runs on DRAFT, PENDING_REVIEW and BLOCKED", async () => {
    for (const status of ["DRAFT", "PENDING_REVIEW", "BLOCKED"]) {
      seed([order({ status })]);
      expect((await runOrderAnomalyCheck(H.db, H.ctx, ORDER, {})).status).toBe("checked");
    }
  });
});

describe("what it stores", () => {
  it("replaces only the rule library's own findings", async () => {
    const blocker = { code: "line_count_shortfall", rule_id: "line_count_shortfall", blocks: true, resolved: false, source: "extraction" };
    const mod = { code: "mod_quote_bom_pending", blocks: true, resolved: true };
    seed([order({ rule_findings: [blocker, mod, { key: "stale_rule", label: "From an older run" }] })]);
    await runOrderAnomalyCheck(H.db, H.ctx, ORDER, {});
    const f = row().rule_findings;
    expect(f).toContainEqual(blocker);
    expect(f).toContainEqual(mod);
    expect(ruleKeys(row())).not.toContain("stale_rule");
    expect(ruleKeys(row())).toContain("duplicate_line");
  });

  it("leaves out the cost rules when the person who saved may not see cost", async () => {
    seed([order()]);
    // A background job carries no person, and so no cost.view.
    await runOrderAnomalyCheck(H.db, { tenantId: T }, ORDER, {});
    expect(row().preflight_payload.anomaly_check.cost_rules).toBe(false);
  });

  it("does not overwrite a save that landed while it ran", async () => {
    seed([order()]);
    const newer = [{ ...LINES[0], quantity: 9, qty: 9 }];
    H.onRead = { customers: async () => {
      H.onRead = null;
      await H.db.from("orders").update({ result: { salesOrder: { lineItems: newer } } }).eq("tenant_id", T).eq("id", ORDER);
    } };
    const out = await runOrderAnomalyCheck(H.db, H.ctx, ORDER, {});
    expect(out.status).toBe("superseded");
    expect(row().result.salesOrder.lineItems).toEqual(newer);
    expect(row().preflight_payload.anomaly_check).toBeUndefined();
  });

  it("reads nothing for another tenant's order", async () => {
    seed([order()]);
    const out = await runOrderAnomalyCheck(H.db, { tenantId: OTHER_T }, ORDER, {});
    expect(out.status).toBe("not_found");
    expect(orderWrites()).toHaveLength(0);
  });
});

describe("an error never breaks the save", () => {
  it("on create: the order and its reconcile stand, and the failure is an event", async () => {
    // The rule library's history read fails; nothing else does.
    H.onSelect = (table, cols) => (table === "orders" && cols === HISTORY ? "error" : undefined);
    const res = await call(createOrder, { method: "POST", body: { customer_id: C1, po_number: "PO-ANOM-4", result: { salesOrder: { lineItems: LINES } } } });
    expect(res._status).toBe(201);
    const r = row(res._json.order.id);
    expect(r.result.salesOrder.lineItems).toHaveLength(2);
    expect(r.result.quoteReconciliation.trigger).toBe("order_created");
    expect(r.preflight_payload.last_validated_at).toBeUndefined();
    const ev = H.events.find((e) => e.eventType === "anomaly_check_failed");
    expect(ev).toMatchObject({ caseId: r.id, detail: { trigger: "order_created" } });
  });

  it("on a line save, even when the library throws", async () => {
    seed([order({ result: {} })]);
    H.onSelect = (table, cols) => (table === "orders" && cols === HISTORY ? "throw" : undefined);
    const res = await call(patchOrder, { method: "PATCH", query: { id: ORDER }, body: { result: { salesOrder: { lineItems: LINES } } } });
    expect(res._status).toBe(200);
    expect(row().result.salesOrder.lineItems).toHaveLength(2);
    expect(H.events.some((e) => e.eventType === "anomaly_check_failed")).toBe(true);
  });

  it("does not hold the caller past its budget", async () => {
    seed([order()]);
    H.onSelect = (table, cols) => (table === "orders" && cols === HISTORY ? 200 : undefined);
    const t0 = Date.now();
    const out = await autoAnomalyCheck(H.db, H.ctx, ORDER, { trigger: "lines_changed", budgetMs: 20 });
    expect(out.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(150);
    expect(H.events.some((e) => e.eventType === "anomaly_check_timeout")).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
  });

  it("does nothing without a tenant", async () => {
    const spy = vi.spyOn(H.db, "from");
    const out = await autoAnomalyCheck(H.db, {}, ORDER, {});
    expect(out.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });
});
