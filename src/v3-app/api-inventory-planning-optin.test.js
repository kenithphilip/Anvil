// Putting the planner on a clock must not change anybody's data until they opt in.
//
// cron/daily.js now runs cron/inventory-planning-weekly.js once a week. That is
// only safe because the planner skips every tenant without
// tenant_settings.inventory_planning_enabled, touches only items with
// item_master.planning_enabled, and leaves procurement plans as DRAFTS for an
// operator to approve. These tests run the real planner (planTenant, and the
// cron handler around it) against an in-memory service client that filters
// rows for real and logs every write, and assert on what was written.
//
// Once it runs on its own, two more things have to hold: nothing another tenant
// holds under the same part number may reach an opted-in tenant's numbers, and a
// tenant on the default hysteresis setting must eventually get a plan.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ db: null }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => h.db.client,
}));

import plannerHandler, { planTenant } from "../api/cron/inventory-planning-weekly.js";
import { makeMockReq, makeMockRes } from "../api/_lib/cron-mux.js";

// v_bom_walk_recursive (migration 085) as Postgres computes it: every edge is a
// root, the walk goes down to depth 8, and the multipliers are summed per
// (root, child). Like the real view it has no tenant_id and its recursive join
// ignores tenants, so a planner that read it would see every tenant's BOM here,
// as it would in production.
const bomWalkView = (bom) => {
  const totals = new Map();
  let level = bom.map((b) => ({ root: b.parent_part_no, child: b.child_part_no, mult: Number(b.qty), depth: 1 }));
  while (level.length) {
    const next = [];
    for (const w of level) {
      const key = JSON.stringify([w.root, w.child]);
      totals.set(key, (totals.get(key) || 0) + w.mult);
      if (w.depth >= 8) continue;
      for (const b of bom) {
        if (b.parent_part_no !== w.child) continue;
        next.push({ root: w.root, child: b.child_part_no, mult: w.mult * Number(b.qty), depth: w.depth + 1 });
      }
    }
    level = next;
  }
  return [...totals].map(([key, total_qty]) => {
    const [root_part_no, child_part_no] = JSON.parse(key);
    return { root_part_no, child_part_no, total_qty };
  });
};

// In-memory stand-in for the Supabase service client. Supports the query
// shapes the planner uses, applies filters to the seeded rows, and records each
// insert / update / upsert / delete in `writes`. An insert gets created_at, as
// the column default does.
const makeDb = (seed) => {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const rowsOf = (name) => (tables[name] ||= []);
  const sourceOf = (name) => (name === "v_bom_walk_recursive" ? bomWalkView(rowsOf("bill_of_materials")) : rowsOf(name));
  const writes = [];
  let seq = 0;

  const from = (table) => {
    const filters = [];
    const where = {};
    let op = "select";
    let payload = null;
    let conflict = null;
    let returning = false;
    let mode = null;
    let orderBy = null;
    let limitN = null;
    const matches = (row) => {
      for (const test of filters) if (!test(row)) return false;
      return true;
    };
    const run = () => {
      if (op === "select") {
        let out = sourceOf(table).filter(matches);
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (limitN != null) out = out.slice(0, limitN);
        if (mode === "single") {
          return out.length === 1
            ? { data: out[0], error: null }
            : { data: null, error: { message: "expected one row in " + table + ", got " + out.length } };
        }
        if (mode === "maybe") return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload])
          .map((r) => ({ id: table + "-" + (++seq), created_at: new Date().toISOString(), ...r }));
        rowsOf(table).push(...list);
        writes.push({ table, op, rows: list.map((r) => ({ ...r })) });
        if (!returning) return { data: null, error: null };
        return { data: mode ? list[0] : list, error: null };
      }
      if (op === "update") {
        const hit = rowsOf(table).filter(matches);
        for (const r of hit) Object.assign(r, payload);
        writes.push({ table, op, where: { ...where }, patch: payload, rows: hit.map((r) => ({ ...r })) });
        return { data: null, error: null };
      }
      if (op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const keys = conflict ? conflict.split(",") : ["id"];
        for (const r of list) {
          const existing = rowsOf(table).find((x) => keys.reduce((same, k) => same && x[k] === r[k], true));
          if (existing) Object.assign(existing, r);
          else rowsOf(table).push({ ...r });
        }
        writes.push({ table, op, rows: list.map((r) => ({ ...r })) });
        return { data: null, error: null };
      }
      const gone = rowsOf(table).filter(matches);
      tables[table] = rowsOf(table).filter((r) => !gone.includes(r));
      writes.push({ table, op, where: { ...where }, rows: gone });
      return { data: null, error: null };
    };
    const q = {
      select: () => { if (op !== "select") returning = true; return q; },
      eq: (col, v) => { where[col] = v; filters.push((r) => r[col] === v); return q; },
      in: (col, list) => { filters.push((r) => list.includes(r[col])); return q; },
      gte: (col, v) => { filters.push((r) => r[col] != null && r[col] >= v); return q; },
      not: (col, operator, v) => {
        if (operator === "is") filters.push((r) => r[col] != null);
        else if (operator === "in") {
          const list = String(v).replace(/^\(|\)$/g, "").split(",");
          filters.push((r) => !list.includes(r[col]));
        } else throw new Error("unsupported not(" + operator + ")");
        return q;
      },
      order: (col, { ascending = true } = {}) => { orderBy = { col, asc: ascending }; return q; },
      limit: (n) => { limitN = n; return q; },
      single: () => { mode = "single"; return q; },
      maybeSingle: () => { mode = "maybe"; return q; },
      insert: (rows) => { op = "insert"; payload = rows; return q; },
      update: (patch) => { op = "update"; payload = patch; return q; },
      upsert: (rows, opts) => { op = "upsert"; payload = rows; conflict = opts?.onConflict || null; return q; },
      delete: () => { op = "delete"; return q; },
      then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
    };
    return q;
  };
  return { client: { from }, tables, writes };
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A Monday, the default planning day. Only Date is faked, so promises and
// timers behave normally.
const NOW = Date.UTC(2026, 9, 5, 2, 30);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const NEXT_WEEK = isoDay(NOW + 7 * DAY_MS);
const THREE_WEEKS_AGO = isoDay(NOW - 21 * DAY_MS);

const item = (tenant_id, part_no, planning_enabled, extra = {}) => ({
  tenant_id, part_no, planning_enabled,
  item_type: "SPARE", default_lead_days: 14, purchase_price: 100,
  demand_class: null, safety_stock: null, reorder_point: null,
  ...extra,
});

// t-on is opted in: a confirmed order line next week, nothing on hand, so it has
// a real shortage to plan for, and one of its guns takes 30 of P-ON.
//
// t-off is not opted in, and holds the SAME part number P-ON with different
// numbers everywhere a planner query is keyed on part_no: its own item row, ten
// times the demand (past and future), a BOM that takes 500 of P-ON, stock on
// hand, and, from when it was opted in, a shortage held back last week and a
// draft plan for this week. A planner query that loses its tenant filter picks
// these up.
//
// inventory_hysteresis_runs defaults to 1 here so a first run may draft a plan;
// the hysteresis tests pass the column's real default, 2.
const seed = ({ hysteresisRuns = 1 } = {}) => ({
  tenant_settings: [
    { tenant_id: "t-on", inventory_planning_enabled: true, inventory_hysteresis_runs: hysteresisRuns },
    { tenant_id: "t-off", inventory_planning_enabled: false, inventory_hysteresis_runs: hysteresisRuns },
  ],
  item_master: [
    item("t-on", "P-ON", true),
    item("t-on", "P-IDLE", false),
    item("t-off", "P-ON", true, { default_lead_days: 70, purchase_price: 9 }),
    item("t-off", "P-OFF", true),
  ],
  order_schedule_lines: [
    { tenant_id: "t-on", part_no: "P-ON", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
    { tenant_id: "t-on", part_no: "P-IDLE", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
    { tenant_id: "t-off", part_no: "P-ON", scheduled_qty: 400, scheduled_date: NEXT_WEEK },
    { tenant_id: "t-off", part_no: "P-ON", scheduled_qty: 400, scheduled_date: THREE_WEEKS_AGO },
    { tenant_id: "t-off", part_no: "P-OFF", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
  ],
  bill_of_materials: [
    { tenant_id: "t-on", parent_part_no: "GUN-ON", child_part_no: "P-ON", qty: 30 },
    { tenant_id: "t-off", parent_part_no: "GUN-OFF", child_part_no: "P-ON", qty: 500 },
  ],
  inventory_positions: [
    { tenant_id: "t-off", part_no: "P-ON", source: "union", on_hand_qty: 5000, as_of: isoDay(NOW) },
  ],
  inventory_exceptions: [
    {
      tenant_id: "t-off", part_no: "P-ON", exception_kind: "below_reorder_point", severity: "info",
      detail: { fingerprint: "hyst:P-ON:" + isoDay(NOW - 7 * DAY_MS) }, status: "open",
      created_at: new Date(NOW - 7 * DAY_MS).toISOString(),
    },
  ],
  procurement_plans: [
    {
      id: "t-off-plan", tenant_id: "t-off", part_no: "P-ON", for_week: isoDay(NOW), status: "draft",
      recommended_qty: 900, created_at: new Date(NOW - 7 * DAY_MS).toISOString(),
    },
  ],
});

// The same seed with one tenant's rows removed (tables kept, so the two can be
// compared table by table).
const withoutTenant = (data, tenantId) => Object.fromEntries(
  Object.entries(data).map(([table, rows]) => [table, rows.filter((r) => r.tenant_id !== tenantId)]),
);

// Every row a tenant holds, table by table (tables where it holds none left out,
// since the stand-in creates a table on first touch).
const rowsHeldBy = (db, tenantId) => Object.fromEntries(
  Object.entries(db.tables)
    .map(([table, rows]) => [table, rows.filter((r) => r.tenant_id === tenantId)])
    .filter(([, rows]) => rows.length > 0),
);

// Which tenants a set of writes landed on, read from the rows written (or, for
// an update, the rows it matched).
const tenantsWritten = (writes) =>
  [...new Set(writes.flatMap((w) => (w.rows || []).map((r) => r.tenant_id)).filter(Boolean))].sort();

const itemRow = (db, tenantId, partNo) =>
  db.tables.item_master.find((x) => x.tenant_id === tenantId && x.part_no === partNo);

const plansIn = (db) => db.writes
  .filter((w) => w.table === "procurement_plans" && w.op === "insert")
  .flatMap((w) => w.rows);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  h.db = makeDb(seed());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("planTenant on a tenant that has not opted in", () => {
  it("writes nothing at all, even with planning-enabled items and live demand", async () => {
    const r = await planTenant(h.db.client, "t-off");
    expect(r).toEqual({ tenant_id: "t-off", skipped: true });
    expect(h.db.writes).toEqual([]);
    expect(itemRow(h.db, "t-off", "P-OFF").safety_stock).toBeNull();
    expect(itemRow(h.db, "t-off", "P-ON").safety_stock).toBeNull();
  });
});

describe("planTenant on an opted-in tenant", () => {
  it("drafts the procurement plan rather than approving it", async () => {
    const r = await planTenant(h.db.client, "t-on");
    expect(r).toMatchObject({ tenant_id: "t-on", items_planned: 1, plans_created: 1 });
    expect(plansIn(h.db).map((p) => [p.tenant_id, p.part_no, p.status])).toEqual([["t-on", "P-ON", "draft"]]);
  });

  it("recomputes only the items flagged planning_enabled", async () => {
    await planTenant(h.db.client, "t-on");
    const updated = h.db.writes
      .filter((w) => w.table === "item_master" && w.op === "update")
      .map((w) => [w.where.tenant_id, w.where.part_no]);
    expect(updated).toEqual([["t-on", "P-ON"]]);
    expect(itemRow(h.db, "t-on", "P-ON").safety_stock).not.toBeNull();
    expect(itemRow(h.db, "t-on", "P-IDLE").safety_stock).toBeNull();
  });

  it("takes the project-equivalent floor from its own BOM, not another tenant's for the same part", async () => {
    // Its gun takes 30 of P-ON; t-off's takes 500. Safety stock is the larger of
    // the statistical figure (about 16 here) and this floor, so it shows directly.
    await planTenant(h.db.client, "t-on");
    expect(itemRow(h.db, "t-on", "P-ON").safety_stock).toBe(30);
  });

  it("sums a multi-level BOM per root and takes the largest root, as v_bom_walk_recursive did", async () => {
    // GUN-BIG takes 20 of P-ON directly and 4 of SUB, which takes 5 each: 40.
    // SUB alone is 5 and GUN-ON is 30, so the floor is 40.
    const data = seed();
    data.bill_of_materials.push(
      { tenant_id: "t-on", parent_part_no: "GUN-BIG", child_part_no: "P-ON", qty: 20 },
      { tenant_id: "t-on", parent_part_no: "GUN-BIG", child_part_no: "SUB", qty: 4 },
      { tenant_id: "t-on", parent_part_no: "SUB", child_part_no: "P-ON", qty: 5 },
    );
    const ownView = bomWalkView(data.bill_of_materials.filter((b) => b.tenant_id === "t-on"))
      .filter((v) => v.child_part_no === "P-ON");
    expect(Math.max(...ownView.map((v) => v.total_qty))).toBe(40);
    h.db = makeDb(data);
    await planTenant(h.db.client, "t-on");
    expect(itemRow(h.db, "t-on", "P-ON").safety_stock).toBe(40);
  });

  it("computes exactly what it computes when the other tenant does not exist", async () => {
    h.db = makeDb(withoutTenant(seed(), "t-off"));
    await planTenant(h.db.client, "t-on");
    const alone = rowsHeldBy(h.db, "t-on");
    expect(alone.procurement_plans).toHaveLength(1);
    expect(alone.demand_forecasts.length).toBeGreaterThan(0);

    h.db = makeDb(seed());
    await planTenant(h.db.client, "t-on");
    expect(rowsHeldBy(h.db, "t-on")).toEqual(alone);
  });

  it("writes only to its own tenant, and leaves the other tenant's copy of the part as it was", async () => {
    const before = rowsHeldBy(h.db, "t-off");
    await planTenant(h.db.client, "t-on");
    expect(tenantsWritten(h.db.writes)).toEqual(["t-on"]);
    expect(rowsHeldBy(h.db, "t-off")).toEqual(before);
  });
});

describe("hysteresis on the column default of 2 runs", () => {
  beforeEach(() => {
    h.db = makeDb(seed({ hysteresisRuns: 2 }));
  });

  const heldBack = () => (rowsHeldBy(h.db, "t-on").inventory_exceptions || [])
    .map((e) => [e.part_no, e.severity, e.detail.fingerprint]);

  it("holds a new shortage back for one week, then drafts the plan on the next weekly run", async () => {
    // t-off's held-back week for its own P-ON is not this tenant's first run.
    const first = await planTenant(h.db.client, "t-on");
    expect(first).toMatchObject({ items_planned: 1, plans_created: 0 });
    expect(heldBack()).toEqual([["P-ON", "info", "hyst:P-ON:" + isoDay(NOW)]]);

    vi.setSystemTime(new Date(NOW + 7 * DAY_MS));
    const second = await planTenant(h.db.client, "t-on");
    expect(second).toMatchObject({ items_planned: 1, plans_created: 1 });
    const plans = plansIn(h.db);
    expect(plans.map((p) => [p.tenant_id, p.part_no, p.status])).toEqual([["t-on", "P-ON", "draft"]]);
    expect(plans[0].rationale).toMatchObject({ hysteresis_streak: 2, hysteresis_required: 2 });
    // The held-back week is not repeated once the plan exists.
    expect(heldBack()).toHaveLength(1);
  });

  it("does not count a second run in the same week as a second run", async () => {
    await planTenant(h.db.client, "t-on");
    vi.setSystemTime(new Date(NOW + 3 * DAY_MS));
    const again = await planTenant(h.db.client, "t-on");
    expect(again).toMatchObject({ items_planned: 1, plans_created: 0 });
    expect(plansIn(h.db)).toEqual([]);
  });
});

describe("the weekly cron handler", () => {
  it("plans the opted-in tenant, leaves the other untouched, and records its heartbeat", async () => {
    const before = rowsHeldBy(h.db, "t-off");
    const { res, _outcome } = makeMockRes();
    await plannerHandler(makeMockReq({ path: "/api/cron/inventory-planning-weekly" }), res);
    expect(_outcome.statusCode).toBe(200);
    const body = JSON.parse(_outcome.body);
    expect(body.tenants.map((t) => [t.tenant_id, t.plans_created])).toEqual([["t-on", 1]]);
    expect(tenantsWritten(h.db.writes)).toEqual(["t-on"]);
    expect(rowsHeldBy(h.db, "t-off")).toEqual(before);
    expect(h.db.tables.cron_health).toEqual([
      expect.objectContaining({ worker: "inventory-planning-weekly", last_status: "ok" }),
    ]);
  });
});
