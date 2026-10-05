// Putting the planner on a clock must not change anybody's data until they opt in.
//
// cron/daily.js now runs cron/inventory-planning-weekly.js once a week. That is
// only safe because the planner skips every tenant without
// tenant_settings.inventory_planning_enabled, touches only items with
// item_master.planning_enabled, and leaves procurement plans as DRAFTS for an
// operator to approve. These tests run the real planner (planTenant, and the
// cron handler around it) against an in-memory service client that filters
// rows for real and logs every write, and assert on what was written.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ db: null }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => h.db.client,
}));

import plannerHandler, { planTenant } from "../api/cron/inventory-planning-weekly.js";
import { makeMockReq, makeMockRes } from "../api/_lib/cron-mux.js";

// In-memory stand-in for the Supabase service client. Supports the query
// shapes the planner uses, applies filters to the seeded rows, and records each
// insert / update / upsert / delete in `writes`.
const makeDb = (seed) => {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const rowsOf = (name) => (tables[name] ||= []);
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
        let out = rowsOf(table).filter(matches);
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
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: table + "-" + (++seq), ...r }));
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

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const NEXT_WEEK = isoDay(Date.now() + 7 * 24 * 60 * 60 * 1000);

const item = (tenant_id, part_no, planning_enabled) => ({
  tenant_id, part_no, planning_enabled,
  item_type: "SPARE", default_lead_days: 14, purchase_price: 100,
  demand_class: null, safety_stock: null, reorder_point: null,
});

// Two tenants with identical demand: a confirmed order line next week and
// nothing on hand, so an opted-in tenant has a real shortage to plan for.
// inventory_hysteresis_runs = 1 so a first run may draft a plan.
const seed = () => ({
  tenant_settings: [
    { tenant_id: "t-on", inventory_planning_enabled: true, inventory_hysteresis_runs: 1 },
    { tenant_id: "t-off", inventory_planning_enabled: false, inventory_hysteresis_runs: 1 },
  ],
  item_master: [
    item("t-on", "P-ON", true),
    item("t-on", "P-IDLE", false),
    item("t-off", "P-OFF", true),
  ],
  order_schedule_lines: [
    { tenant_id: "t-on", part_no: "P-ON", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
    { tenant_id: "t-on", part_no: "P-IDLE", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
    { tenant_id: "t-off", part_no: "P-OFF", scheduled_qty: 40, scheduled_date: NEXT_WEEK },
  ],
});

// Which tenants a set of writes landed on, read from the rows written (or, for
// an update, the rows it matched).
const tenantsWritten = (writes) =>
  [...new Set(writes.flatMap((w) => (w.rows || []).map((r) => r.tenant_id)).filter(Boolean))].sort();

beforeEach(() => {
  h.db = makeDb(seed());
});

describe("planTenant on a tenant that has not opted in", () => {
  it("writes nothing at all, even with planning-enabled items and live demand", async () => {
    const r = await planTenant(h.db.client, "t-off");
    expect(r).toEqual({ tenant_id: "t-off", skipped: true });
    expect(h.db.writes).toEqual([]);
    expect(h.db.tables.item_master.find((x) => x.part_no === "P-OFF").safety_stock).toBeNull();
  });
});

describe("planTenant on an opted-in tenant", () => {
  it("drafts the procurement plan rather than approving it", async () => {
    const r = await planTenant(h.db.client, "t-on");
    expect(r).toMatchObject({ tenant_id: "t-on", items_planned: 1, plans_created: 1 });
    const plans = h.db.writes
      .filter((w) => w.table === "procurement_plans" && w.op === "insert")
      .flatMap((w) => w.rows);
    expect(plans.map((p) => [p.tenant_id, p.part_no, p.status])).toEqual([["t-on", "P-ON", "draft"]]);
  });

  it("recomputes only the items flagged planning_enabled", async () => {
    await planTenant(h.db.client, "t-on");
    const updated = h.db.writes
      .filter((w) => w.table === "item_master" && w.op === "update")
      .map((w) => w.where.part_no);
    expect(updated).toEqual(["P-ON"]);
    expect(h.db.tables.item_master.find((x) => x.part_no === "P-ON").safety_stock).not.toBeNull();
    expect(h.db.tables.item_master.find((x) => x.part_no === "P-IDLE").safety_stock).toBeNull();
  });

  it("writes only to its own tenant", async () => {
    await planTenant(h.db.client, "t-on");
    expect(tenantsWritten(h.db.writes)).toEqual(["t-on"]);
  });
});

describe("the weekly cron handler", () => {
  it("plans the opted-in tenant, leaves the other untouched, and records its heartbeat", async () => {
    const { res, _outcome } = makeMockRes();
    await plannerHandler(makeMockReq({ path: "/api/cron/inventory-planning-weekly" }), res);
    expect(_outcome.statusCode).toBe(200);
    const body = JSON.parse(_outcome.body);
    expect(body.tenants.map((t) => [t.tenant_id, t.plans_created])).toEqual([["t-on", 1]]);
    expect(tenantsWritten(h.db.writes)).toEqual(["t-on"]);
    expect(h.db.tables.cron_health).toEqual([
      expect.objectContaining({ worker: "inventory-planning-weekly", last_status: "ok" }),
    ]);
  });
});
