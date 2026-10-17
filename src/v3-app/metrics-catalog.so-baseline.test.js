// Plan C-7 (audit PR 1): the SO cycle and rework baseline in the governed
// metric catalog. Five metrics, each rebuilt from the append-only order audit
// rows: time to SO, engineer time to submit, approval wait, re-work rate and
// actions per order by role.
//
// The tests drive computeMetric, POST /api/metrics and the copilot's
// query_metric tool against an in-memory table store whose query builder
// APPLIES its filters (eq / in / gte / order / range) and its projection
// (including "alias:col->>key"), so a missing tenant filter or a wrong status
// path shows up as a wrong number.
//
// Fixture (tenant A, all created in the window):
//   O1  returned twice, then approved
//   O2  approved, returned after approval, approved again; orders.approved_at
//       holds the SECOND approval, as the PATCH leaves it
//   O3  created by an inbound path (no create_order row), sent, cancelled
//   O4  still a draft
// Tenant B has its own fast order, and a forged approve row naming O3's id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = { tables: {}, seq: 1000 };
  const MAX_ROWS = 1000;
  const rowsOf = (t) => (state.tables[t] = state.tables[t] || []);
  const cmp = (a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  const makeQuery = (table) => {
    const st = { op: "select", payload: null, filters: [], orders: [], range: null, columns: null };
    const project = (row) => {
      if (!st.columns || st.columns.trim() === "*") return row;
      const out = {};
      for (const raw of st.columns.split(",")) {
        const tok = raw.trim();
        if (!tok) continue;
        const [name, expr] = tok.includes(":") ? tok.split(":") : [tok, tok];
        if (expr.includes("->>")) {
          const [col, key] = expr.split("->>");
          const v = row[col] && row[col][key];
          out[name] = v == null ? null : String(v);
        } else {
          out[name] = row[expr] === undefined ? null : row[expr];
        }
      }
      return out;
    };
    const exec = () => {
      if (st.op === "insert") {
        const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
        const inserted = arr.map((r) => ({ id: (state.seq += 1), created_at: new Date().toISOString(), ...r }));
        rowsOf(table).push(...inserted);
        return { data: inserted, error: null };
      }
      let data = rowsOf(table).filter((r) => st.filters.every((f) => f(r))).map((r) => ({ ...r }));
      if (st.orders.length) {
        data.sort((a, b) => {
          for (const { k, asc } of st.orders) {
            const d = cmp(a[k], b[k]);
            if (d) return asc ? d : -d;
          }
          return 0;
        });
      }
      if (st.range) data = data.slice(st.range[0], st.range[1] + 1);
      // PostgREST stops at its max-rows setting and says nothing.
      return { data: data.slice(0, MAX_ROWS).map(project), error: null };
    };
    const q = {
      select: (cols) => { st.columns = cols == null ? null : String(cols); return q; },
      insert: (p) => { st.op = "insert"; st.payload = p; return q; },
      eq: (k, v) => { st.filters.push((r) => r[k] === v); return q; },
      in: (k, vs) => { st.filters.push((r) => vs.includes(r[k])); return q; },
      gte: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return q; },
      order: (k, o) => { st.orders.push({ k, asc: !(o && o.ascending === false) }); return q; },
      range: (from, to) => { st.range = [from, to]; return q; },
      limit: () => q,
      then: (res, rej) => Promise.resolve().then(exec).then(res, rej),
    };
    return q;
  };
  return { state, rowsOf, svc: { from: (t) => makeQuery(t) }, ctx: null };
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => h.svc }));
vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, resolveContext: vi.fn(async () => h.ctx) };
});

const { computeMetric, listMetrics } = await import("../api/_lib/metrics/catalog.js");
const { default: metricsHandler } = await import("../api/metrics/index.js");
const { dispatchErpChatTool } = await import("../api/_lib/erp-chat-tools.js");

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ENG = "11111111-0000-4000-8000-0000000000e1";
const MGR = "11111111-0000-4000-8000-0000000000m1";
const O1 = "0a000000-0000-4000-8000-000000000001";
const O2 = "0a000000-0000-4000-8000-000000000002";
const O3 = "0a000000-0000-4000-8000-000000000003";
const O4 = "0a000000-0000-4000-8000-000000000004";
const OB = "0b000000-0000-4000-8000-000000000001";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const BASE = NOW - 10 * DAY;

let seq = 0;
const orderRow = (tenant, id, createdMs, extra = {}) => ({
  id, tenant_id: tenant, created_at: iso(createdMs), status: "DRAFT", approved_at: null, ...extra,
});
// One audit row as recordAudit writes it from orders/[id].js: the whole order
// before and after the PATCH.
const auditRow = (tenant, orderId, ms, action, from, to, who = "eng") => {
  const person = { eng: [ENG, "sales_engineer"], mgr: [MGR, "sales_manager"], system: [null, null] }[who];
  return {
    id: (seq += 1),
    tenant_id: tenant, object_type: "order", object_id: orderId, action,
    actor: person[0], actor_role: person[1],
    created_at: iso(ms),
    before_payload: from ? { id: orderId, status: from, result: { lines: [{ qty: 1 }] } } : null,
    after_payload: to ? { id: orderId, status: to, result: { lines: [{ qty: 1 }] } } : null,
  };
};

const B1 = BASE;
const B2 = BASE + 1 * DAY;
const B3 = BASE + 2 * DAY;
const B4 = BASE + 3 * DAY;
const at = (base, hours) => base + hours * HOUR;

const seedTenantA = () => [
  // O1: sent at 1 h, returned at 2 h and 4 h, approved at 7 h.
  auditRow(TENANT_A, O1, at(B1, 0), "create_order", null, "DRAFT"),
  auditRow(TENANT_A, O1, at(B1, 0.5), "update_order", "DRAFT", "DRAFT"),
  auditRow(TENANT_A, O1, at(B1, 0.6), "order_quote_attached", null, null),
  auditRow(TENANT_A, O1, at(B1, 1), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O1, at(B1, 1), "approval_thresholds_evaluated", null, null),
  auditRow(TENANT_A, O1, at(B1, 2), "manager_requested_correction", "PENDING_REVIEW", "DRAFT", "mgr"),
  auditRow(TENANT_A, O1, at(B1, 3), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O1, at(B1, 4), "manager_requested_correction", "PENDING_REVIEW", "DRAFT", "mgr"),
  auditRow(TENANT_A, O1, at(B1, 5), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O1, at(B1, 7), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
  auditRow(TENANT_A, O1, at(B1, 8), "so_pdf_downloaded", null, null),
  // O2: sent at 2 h, approved at 3 h, returned at 5 h, approved again at 10 h.
  auditRow(TENANT_A, O2, at(B2, 0), "create_order", null, "DRAFT"),
  auditRow(TENANT_A, O2, at(B2, 2), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O2, at(B2, 3), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
  auditRow(TENANT_A, O2, at(B2, 5), "manager_requested_correction", "APPROVED", "DRAFT", "mgr"),
  // A save written with no person behind it (an agent run).
  auditRow(TENANT_A, O2, at(B2, 5.5), "update_order", "DRAFT", "DRAFT", "system"),
  auditRow(TENANT_A, O2, at(B2, 6), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O2, at(B2, 10), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
  // O3: an inbound draft (no create_order row), sent at 4 h, cancelled at 12 h.
  auditRow(TENANT_A, O3, at(B3, 4), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_A, O3, at(B3, 12), "update_order", "PENDING_REVIEW", "CANCELLED", "mgr"),
  // O4: created, never sent. A system row (no actor) is not a person's action.
  auditRow(TENANT_A, O4, at(B4, 0), "create_order", null, "DRAFT", "system"),
];

const seedTenantB = () => [
  // B's own order, approved in half an hour.
  auditRow(TENANT_B, OB, at(B1, 0), "create_order", null, "DRAFT"),
  auditRow(TENANT_B, OB, at(B1, 0.2), "update_order", "DRAFT", "PENDING_REVIEW"),
  auditRow(TENANT_B, OB, at(B1, 0.5), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
  // A forged row in tenant B that names tenant A's cancelled order.
  auditRow(TENANT_B, O3, at(B3, 5), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
];

beforeEach(() => {
  seq = 0;
  h.state.tables = {
    orders: [
      orderRow(TENANT_A, O1, B1, { status: "APPROVED", approved_at: iso(at(B1, 7)) }),
      // approved_at is the SECOND approval: each approval overwrites it.
      orderRow(TENANT_A, O2, B2, { status: "APPROVED", approved_at: iso(at(B2, 10)) }),
      orderRow(TENANT_A, O3, B3, { status: "CANCELLED" }),
      orderRow(TENANT_A, O4, B4),
      orderRow(TENANT_B, OB, B1, { status: "APPROVED", approved_at: iso(at(B1, 0.5)) }),
    ],
    audit_events: [...seedTenantA(), ...seedTenantB()],
  };
  h.ctx = { user: { id: MGR }, tenantId: TENANT_A, role: "sales_manager", anonymous: false };
});

const metric = (id, params = {}) => computeMetric(h.svc, TENANT_A, id, params, NOW);

describe("time to SO", () => {
  it("measures created to the FIRST approval, so a re-approval does not move it", async () => {
    const r = await metric("so_time_to_so_hours");
    expect(r).toMatchObject({ metric_id: "so_time_to_so_hours", unit: "hours", domain: "operations", window_days: 90 });
    // O1 7 h, O2 3 h (its first approval; approved_at says 10 h).
    expect(r.value).toBe(5);
    expect(r.breakdown).toEqual([{ label: "P50", value: 5 }, { label: "P90", value: 7 }]);
    expect(r).toMatchObject({ count: 2, denominator: 4 });
    expect(r.evidence).toMatchObject({ table: "audit_events", total_orders: 2, pending: 1, cancelled_before_approval: 1 });
    expect([...r.evidence.order_ids].sort()).toEqual([O1, O2]);
    expect(r.provenance).toMatch(/approved_at is not read/);
    expect(r.as_of).toBe(new Date(NOW).toISOString());
  });

  it("an order approved twice reports its first approval, not orders.approved_at", async () => {
    h.state.tables.orders = h.state.tables.orders.filter((o) => o.id === O2);
    const r = await metric("so_time_to_so_hours");
    expect(r.value).toBe(3);
    expect(r.breakdown).toEqual([{ label: "P50", value: 3 }, { label: "P90", value: 3 }]);
  });

  it("leaves a cancelled order out, and says no data when nothing reached an SO", async () => {
    h.state.tables.orders = h.state.tables.orders.filter((o) => o.id === O3);
    const r = await metric("so_time_to_so_hours");
    expect(r.value).toBeNull();
    expect(r.breakdown).toEqual([]);
    expect(r).toMatchObject({ count: 0, denominator: 1 });
    expect(r.evidence).toMatchObject({ cancelled_before_approval: 1, pending: 0 });
  });
});

describe("engineer time to submit", () => {
  it("measures created to the first PENDING_REVIEW, the inbound order included", async () => {
    const r = await metric("so_submit_time_hours");
    // O1 1 h, O2 2 h, O3 4 h; O4 is still a draft.
    expect(r.value).toBe(2);
    expect(r.breakdown).toEqual([{ label: "P50", value: 2 }, { label: "P90", value: 4 }]);
    expect(r).toMatchObject({ count: 3, denominator: 4, unit: "hours" });
    expect(r.evidence).toMatchObject({ pending: 1, cancelled_before_submit: 0 });
  });
});

describe("approval wait", () => {
  it("measures the first submission to the first decision, split by outcome", async () => {
    const r = await metric("so_approval_wait_hours");
    // O1 returned after 1 h, O2 approved after 1 h, O3 cancelled after 8 h.
    expect(r.value).toBe(1);
    expect(r.breakdown).toEqual([{ label: "P50", value: 1 }, { label: "P90", value: 8 }]);
    expect(r).toMatchObject({ count: 3, denominator: 3 });
    expect(r.evidence.by_outcome).toEqual({ returned: 1, approved: 1, cancelled: 1 });
    expect(r.evidence.waiting).toBe(0);
  });

  it("an order still in review is waiting, not measured", async () => {
    h.state.tables.audit_events.push(auditRow(TENANT_A, O4, at(B4, 1), "update_order", "DRAFT", "PENDING_REVIEW"));
    const r = await metric("so_approval_wait_hours");
    expect(r).toMatchObject({ count: 3, denominator: 4 });
    expect(r.evidence.waiting).toBe(1);
  });
});

describe("re-work rate", () => {
  it("counts manager_requested_correction rows over the orders sent for review", async () => {
    const r = await metric("so_rework_rate");
    // Sent: O1, O2, O3. Returned: O1 twice, O2 once.
    expect(r).toMatchObject({ unit: "percent", value: 66.7, count: 2, denominator: 3 });
    expect(r.breakdown).toEqual({ returns: 3, returns_per_order: 1, max_returns: 2 });
    expect([...r.evidence.order_ids].sort()).toEqual([O1, O2]);
  });

  it("the two-return order alone is one reworked order with two returns", async () => {
    h.state.tables.orders = h.state.tables.orders.filter((o) => o.id === O1);
    const r = await metric("so_rework_rate");
    expect(r).toMatchObject({ value: 100, count: 1, denominator: 1 });
    expect(r.breakdown).toEqual({ returns: 2, returns_per_order: 2, max_returns: 2 });
  });
});

describe("actions per order", () => {
  it("counts a person's state-changing actions per approved order, by role", async () => {
    const r = await metric("so_actions_per_order");
    // O1: the engineer's create, save, quote attach and three sends (6), and
    // the manager's two returns and approval (3). O2: 3 and 3. The threshold
    // row, the PDF download, the agent's save on O2 and O3 (never approved)
    // do not count.
    expect(r).toMatchObject({ unit: "count", value: 7.5, count: 2 });
    expect(r.breakdown).toEqual([
      { label: "sales_engineer", value: 4.5, count: 9 },
      { label: "sales_manager", value: 3, count: 6 },
    ]);
    expect(r.evidence).toMatchObject({ actions: 15, median: 7.5 });
    expect(r.evidence.by_action).toEqual({
      create_order: 2, update_order: 6, order_quote_attached: 1,
      manager_requested_correction: 3, approve_order: 3,
    });
  });
});

describe("tenant isolation and the window", () => {
  it("a forged row in another tenant naming this tenant's order does not approve it", async () => {
    const r = await metric("so_time_to_so_hours");
    expect(r.evidence.cancelled_before_approval).toBe(1);
    expect(r.evidence.order_ids).not.toContain(O3);
    const wait = await metric("so_approval_wait_hours");
    expect(wait.evidence.by_outcome.cancelled).toBe(1);
  });

  it("another tenant's orders and history stay out of every number", async () => {
    const tta = await metric("so_time_to_so_hours");
    expect(tta.denominator).toBe(4);
    expect(tta.evidence.order_ids).not.toContain(OB);
    const b = await computeMetric(h.svc, TENANT_B, "so_time_to_so_hours", {}, NOW);
    // Tenant B sees only its own order, approved in half an hour.
    expect(b).toMatchObject({ value: 0.5, count: 1, denominator: 1 });
  });

  it("fails closed without a tenant", async () => {
    await expect(computeMetric(h.svc, undefined, "so_time_to_so_hours", {}, NOW)).rejects.toThrow(/tenant/);
  });

  it("the window bounds the cohort", async () => {
    const OLD = "0a000000-0000-4000-8000-0000000000ff";
    const B0 = NOW - 40 * DAY;
    h.state.tables.orders.push(orderRow(TENANT_A, OLD, B0, { status: "APPROVED" }));
    h.state.tables.audit_events.push(
      auditRow(TENANT_A, OLD, at(B0, 1), "update_order", "DRAFT", "PENDING_REVIEW"),
      auditRow(TENANT_A, OLD, at(B0, 20), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
    );
    const wide = await metric("so_time_to_so_hours", { window_days: 90 });
    expect(wide).toMatchObject({ count: 3, denominator: 5, window_days: 90 });
    expect(wide.breakdown).toEqual([{ label: "P50", value: 7 }, { label: "P90", value: 20 }]);
    const narrow = await metric("so_time_to_so_hours", { window_days: 30 });
    expect(narrow).toMatchObject({ value: 5, count: 2, denominator: 4, window_days: 30 });
  });

  it("reads the history past PostgREST's 1000-row page", async () => {
    h.state.tables.orders = h.state.tables.orders.filter((o) => o.id === O4);
    const saves = Array.from({ length: 1100 }, (_, i) =>
      auditRow(TENANT_A, O4, at(B4, 0.001 * (i + 1)), "update_order", "DRAFT", "DRAFT"));
    h.state.tables.audit_events.push(
      ...saves,
      auditRow(TENANT_A, O4, at(B4, 2), "update_order", "DRAFT", "PENDING_REVIEW"),
      auditRow(TENANT_A, O4, at(B4, 6), "approve_order", "PENDING_REVIEW", "APPROVED", "mgr"),
    );
    const r = await metric("so_time_to_so_hours");
    expect(r).toMatchObject({ value: 6, count: 1, denominator: 1 });
    expect(r.evidence.capped).toBeUndefined();
  });
});

describe("the callers: /api/metrics and the copilot tool", () => {
  const call = async (req) => {
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      send(p) { this.body = p; return this; },
      json(o) { this.body = JSON.stringify(o); return this; },
      end() { return this; },
    };
    await metricsHandler({ headers: {}, query: {}, ...req }, res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  it("lists the five baseline metrics", async () => {
    const r = await call({ method: "GET" });
    expect(r.status).toBe(200);
    const ids = r.body.metrics.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([
      "so_time_to_so_hours", "so_submit_time_hours", "so_approval_wait_hours", "so_rework_rate", "so_actions_per_order",
    ]));
    expect(listMetrics().find((m) => m.id === "so_rework_rate")).toMatchObject({ unit: "percent", params: ["window_days"] });
  });

  it("POST /api/metrics computes for the caller's tenant and audits the query", async () => {
    const r = await call({ method: "POST", body: { metric_id: "so_rework_rate", window_days: 60 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ metric_id: "so_rework_rate", value: 66.7, count: 2, denominator: 3, window_days: 60 });
    const q = h.rowsOf("audit_events").filter((a) => a.action === "metric_query");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ tenant_id: TENANT_A, object_id: "so_rework_rate", actor: MGR });
  });

  it("the copilot's query_metric returns the same number for its tenant", async () => {
    const a = await dispatchErpChatTool(TENANT_A, "query_metric", { metric_id: "so_time_to_so_hours" });
    expect(a).toMatchObject({ metric_id: "so_time_to_so_hours", value: 5, unit: "hours" });
    const b = await dispatchErpChatTool(TENANT_B, "query_metric", { metric_id: "so_time_to_so_hours" });
    expect(b).toMatchObject({ value: 0.5, count: 1, denominator: 1 });
  });
});
