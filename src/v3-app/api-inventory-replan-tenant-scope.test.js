// The admin "Run replan now" button (POST /api/inventory/replan) runs the
// planner on the service role, so tenant scoping lives in the planner's own
// queries. Its project-equivalent safety-stock floor used to read
// v_bom_walk_recursive (migration 085), a view with no tenant_id whose
// recursive join does not match on tenant: a replan for tenant A was sized
// from tenant B's BOM whenever the two shared a part number.
//
// The fake database below holds bill_of_materials rows for BOTH tenants and
// derives the two BOM views from them exactly as their SQL does: 085 walks
// every edge regardless of tenant, 183 joins on tenant_id at every hop. Every
// other read honours the handler's own filters, so a cross-tenant number can
// only reach the plan through a query that forgot to scope itself.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ tenant: null, db: {}, fail: {}, reads: [], updates: [], inserts: [] }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-admin" }, tenantId: H.tenant, role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/cron-mux.js", () => ({ recordCronHeartbeat: vi.fn(async () => {}) }));

// v_bom_walk_recursive (085): roots are every parent, the recursive step joins
// on part number alone, so a walk that starts on one tenant's edge continues
// down another tenant's edges.
const walkView = (bom) => {
  let level = bom.map((b) => ({ root: b.parent_part_no, child: b.child_part_no, m: Number(b.qty), depth: 1 }));
  const walk = [...level];
  while (level.length) {
    const next = [];
    for (const w of level) {
      if (w.depth >= 8) continue;
      for (const b of bom) {
        if (b.parent_part_no === w.child) next.push({ root: w.root, child: b.child_part_no, m: w.m * Number(b.qty), depth: w.depth + 1 });
      }
    }
    walk.push(...next);
    level = next;
  }
  const out = new Map();
  for (const w of walk) {
    const key = w.root + "|" + w.child;
    const row = out.get(key) || { root_part_no: w.root, child_part_no: w.child, total_qty: 0 };
    row.total_qty += w.m;
    out.set(key, row);
  }
  return [...out.values()];
};

// v_bom_where_used_recursive (183): the reverse walk, joined on tenant_id at
// every hop and carrying it out.
const whereUsedView = (bom) => {
  let level = bom.map((b) => ({ tenant_id: b.tenant_id, part: b.child_part_no, asm: b.parent_part_no, m: Number(b.qty), depth: 1 }));
  const up = [...level];
  while (level.length) {
    const next = [];
    for (const u of level) {
      if (u.depth >= 8) continue;
      for (const b of bom) {
        if (b.tenant_id === u.tenant_id && b.child_part_no === u.asm) {
          next.push({ tenant_id: u.tenant_id, part: u.part, asm: b.parent_part_no, m: u.m * Number(b.qty), depth: u.depth + 1 });
        }
      }
    }
    up.push(...next);
    level = next;
  }
  const out = new Map();
  for (const u of up) {
    const key = u.tenant_id + "|" + u.part + "|" + u.asm;
    const row = out.get(key) || { tenant_id: u.tenant_id, part_no: u.part, assembly_part_no: u.asm, depth: u.depth, total_qty: 0 };
    row.total_qty += u.m;
    row.depth = Math.min(row.depth, u.depth);
    out.set(key, row);
  }
  return [...out.values()];
};

const relation = (table) => {
  if (table === "v_bom_walk_recursive") return walkView(H.db.bill_of_materials || []);
  if (table === "v_bom_where_used_recursive") return whereUsedView(H.db.bill_of_materials || []);
  return H.db[table] || [];
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const filters = [];
      let mode = "select";
      let payload = null;
      let orderBy = null;
      let limitN = null;
      const matches = (row) => {
        for (const f of filters) if (!f(row)) return false;
        return true;
      };
      const rows = () => {
        let out = relation(table).filter(matches);
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        return limitN == null ? out : out.slice(0, limitN);
      };
      const run = () => {
        if (mode === "insert") {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const r of list) H.inserts.push({ table, row: r });
          return { data: { id: table + "-" + H.inserts.length }, error: null };
        }
        if (mode === "update") {
          H.updates.push({ table, patch: payload, filters: api.eqs });
          return { data: null, error: null };
        }
        if (mode === "upsert") return { data: null, error: null };
        H.reads.push({ table, eqs: api.eqs });
        if (H.fail[table]) return { data: null, error: { message: H.fail[table] } };
        return { data: rows(), error: null };
      };
      const api = {
        eqs: {},
        select: () => api,
        eq: (col, val) => { api.eqs[col] = val; filters.push((r) => r[col] === val); return api; },
        in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return api; },
        not: (col, op, val) => {
          if (op === "is" && val === null) filters.push((r) => r[col] != null);
          if (op === "in") {
            const list = String(val).replace(/[()]/g, "").split(",");
            filters.push((r) => !list.includes(r[col]));
          }
          return api;
        },
        gte: () => api,
        order: (col, opts = {}) => { orderBy = { col, asc: opts.ascending !== false }; return api; },
        limit: (n) => { limitN = n; return api; },
        insert: (row) => { mode = "insert"; payload = row; return api; },
        update: (patch) => { mode = "update"; payload = patch; return api; },
        upsert: (row) => { mode = "upsert"; payload = row; return api; },
        single: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error };
        },
        maybeSingle: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error };
        },
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
      };
      return api;
    },
  }),
}));

const { default: replan } = await import("../api/inventory/replan.js");

const TA = "tenant-a";
const TB = "tenant-b";

// Both tenants stock SEAL-10 and both have a SHANK-3. Tenant A builds GUN-1
// from 2 x SHANK-3, each holding 3 x SEAL-10, so one GUN-1 consumes 6 seals.
// Tenant B's SHANK-3 holds 50 seals, and only tenant B uses NOZZLE-7.
const seed = () => {
  const item = (tenant_id, part_no) => ({
    tenant_id, part_no, planning_enabled: true, item_type: "SPARE",
    default_supplier_id: null, default_lead_days: 14, moq: 1, pack_size: 1,
  });
  H.db = {
    tenant_settings: [
      { tenant_id: TA, inventory_planning_enabled: true },
      { tenant_id: TB, inventory_planning_enabled: true },
    ],
    item_master: [
      item(TA, "SEAL-10"), item(TA, "NOZZLE-7"),
      item(TB, "SEAL-10"), item(TB, "NOZZLE-7"),
    ],
    bill_of_materials: [
      { tenant_id: TA, parent_part_no: "GUN-1", child_part_no: "SHANK-3", qty: 2 },
      { tenant_id: TA, parent_part_no: "SHANK-3", child_part_no: "SEAL-10", qty: 3 },
      { tenant_id: TB, parent_part_no: "SHANK-3", child_part_no: "SEAL-10", qty: 50 },
      { tenant_id: TB, parent_part_no: "GUN-9", child_part_no: "NOZZLE-7", qty: 40 },
    ],
  };
};

const runReplan = async (tenant) => {
  H.tenant = tenant;
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await replan({ method: "POST", headers: {}, url: "/api/inventory/replan", query: {}, body: {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

// The safety stock the planner wrote back to item_master for one part.
const safetyStockWritten = (partNo) => {
  const hits = H.updates.filter((u) => u.table === "item_master" && u.filters.part_no === partNo);
  expect(hits).toHaveLength(1);
  return hits[0];
};

beforeEach(() => {
  seed();
  H.fail = {};
  H.reads = [];
  H.updates = [];
  H.inserts = [];
});

describe("replan sizes the project-equivalent floor from the caller's own BOM", () => {
  it("tenant A's seal floor is the 6 its own GUN-1 consumes, not a total through tenant B's SHANK-3", async () => {
    const out = await runReplan(TA);
    expect(out.statusCode).toBe(200);
    expect(out.body.result.items_planned).toBe(2);
    const seal = safetyStockWritten("SEAL-10");
    expect(seal.filters.tenant_id).toBe(TA);
    // No demand history, so the floor IS the safety stock: 2 x SHANK-3 x 3 seals.
    expect(seal.patch.safety_stock).toBe(6);
  });

  it("a part only tenant B's BOM uses gets tenant A the no-BOM fallback of 1, not B's 40", async () => {
    await runReplan(TA);
    const nozzle = safetyStockWritten("NOZZLE-7");
    expect(nozzle.filters.tenant_id).toBe(TA);
    expect(nozzle.patch.safety_stock).toBe(1);
  });

  it("tenant B gets its own figures from the same shared part numbers", async () => {
    await runReplan(TB);
    expect(safetyStockWritten("SEAL-10").patch.safety_stock).toBe(50);
    expect(safetyStockWritten("NOZZLE-7").patch.safety_stock).toBe(40);
  });

  it("every BOM relation the replan reads is filtered to the caller's tenant", async () => {
    await runReplan(TA);
    const bomReads = H.reads.filter((r) => r.table === "bill_of_materials" || r.table.startsWith("v_bom_"));
    // One explosion read plus one floor lookup per part.
    expect(bomReads.map((r) => r.table).sort()).toEqual([
      "bill_of_materials", "v_bom_where_used_recursive", "v_bom_where_used_recursive",
    ]);
    for (const r of bomReads) expect(r.eqs.tenant_id).toBe(TA);
  });
});

// A failed floor read is not an empty one. Before, the planner read
// walk.data?.[0], fell through to the fallback of 1 and wrote that guess to
// item_master.safety_stock; a failed installed-parts read fell through to the
// BOM walk the same way. The replan now refuses, as its other reads do.
describe("replan refuses rather than guessing a floor when a floor read fails", () => {
  const itemMasterWrites = () => H.updates.filter((u) => u.table === "item_master");

  it("a where-used view error returns the error and writes no safety stock", async () => {
    H.fail.v_bom_where_used_recursive = "canceling statement due to statement timeout";
    const out = await runReplan(TA);
    expect(out.statusCode).toBe(500);
    expect(out.body.error.message).toBe("bom floor: canceling statement due to statement timeout");
    expect(H.reads.filter((r) => r.table === "v_bom_where_used_recursive")).toHaveLength(1);
    expect(itemMasterWrites()).toEqual([]);
  });

  it("an installed-parts error returns the error instead of falling through to the BOM", async () => {
    H.fail.equipment_installed_parts = "relation \"equipment_installed_parts\" does not exist";
    const out = await runReplan(TA);
    expect(out.statusCode).toBe(500);
    expect(out.body.error.message).toBe("installed parts floor: relation \"equipment_installed_parts\" does not exist");
    expect(H.reads.filter((r) => r.table === "equipment_installed_parts")).toHaveLength(1);
    expect(H.reads.filter((r) => r.table === "v_bom_where_used_recursive")).toEqual([]);
    expect(itemMasterWrites()).toEqual([]);
  });
});
