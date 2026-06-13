// Tests for P4 logistics freight bidding: the pure consolidation engine
// (_lib/freight-consolidation.js) plus the consolidations + bids
// endpoints driven against a shared in-memory store.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { estimateContainers, consolidatePlans } from "../api/_lib/freight-consolidation.js";

describe("estimateContainers", () => {
  it("returns none for an empty load", () => {
    expect(estimateContainers(0, 0).recommended_mode).toBe("none");
  });
  it("recommends LCL for a small load", () => {
    const c = estimateContainers(1000, 5);
    expect(c).toMatchObject({ fcl_40: 0, fcl_20: 0, recommended_mode: "LCL" });
    expect(c.lcl_cbm).toBe(5);
  });
  it("fills exactly one 40ft", () => {
    const c = estimateContainers(26000, 30);
    expect(c).toMatchObject({ fcl_40: 1, fcl_20: 0, recommended_mode: "FCL" });
  });
  it("adds a 20ft when the remainder is >=60% of one", () => {
    const c = estimateContainers(0, 90);   // 90cbm: 1x40 (67) + 23cbm rem = 0.70 of a 20ft
    expect(c).toMatchObject({ fcl_40: 1, fcl_20: 1, recommended_mode: "FCL" });
  });
  it("LCLs a small remainder after a 40ft (mixed)", () => {
    const c = estimateContainers(0, 75);   // 1x40 (67) + 8cbm rem = 0.24 of a 20ft
    expect(c.fcl_40).toBe(1);
    expect(c.fcl_20).toBe(0);
    expect(c.lcl_cbm).toBe(8);
    expect(c.recommended_mode).toBe("mixed");
  });
});

describe("consolidatePlans", () => {
  it("groups by origin + week, multiplies qty by per-unit dims", () => {
    const out = consolidatePlans([
      { id: "p1", part_no: "A", qty: 10, origin: "O-KOREA", window_week: "2026-06-08", weight_kg: 2, volume_cbm: 0 },
      { id: "p2", part_no: "B", qty: 5, origin: "O-KOREA", window_week: "2026-06-08", weight_kg: 4, volume_cbm: 0 },
      { id: "p3", part_no: "C", qty: 1, origin: "O-INDIA", window_week: "2026-06-08", weight_kg: 1, volume_cbm: 0 },
    ], { destination: "IN" });
    const korea = out.find((g) => g.origin === "O-KOREA");
    expect(korea.weight_kg).toBe(40);             // 10*2 + 5*4
    expect(korea.plan_ids).toEqual(["p1", "p2"]);
    expect(korea.containers.recommended_mode).toBe("LCL");
    expect(out).toHaveLength(2);                   // two origins
  });
  it("flags parts with no shipping dimensions", () => {
    const out = consolidatePlans([
      { id: "p1", part_no: "NO-DIMS", qty: 3, origin: "O-KOREA", window_week: "2026-06-08" },
    ], {});
    expect(out[0].missing_dims).toEqual(["NO-DIMS"]);
  });
});

// ── Endpoints ───────────────────────────────────────────────────────────
const H = vi.hoisted(() => {
  const tables = {}; let idc = 0;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = []; let op = "select", payload = null, conflict = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "insert") { const a = Array.isArray(payload) ? payload : [payload]; const ins = a.map((p) => { const r = { id: "id-" + (++idc), ...clone(p) }; tables[table].push(r); return clone(r); }); return { data: ins, error: null, __rows: ins }; }
      if (op === "upsert") { const keys = (conflict || "").split(",").map((s) => s.trim()); const ex = keys.length ? tables[table].find((r) => keys.every((k) => r[k] === payload[k])) : null; if (ex) { Object.assign(ex, clone(payload)); return { data: [clone(ex)], error: null, __rows: [clone(ex)] }; } const r = { id: "id-" + (++idc), ...clone(payload) }; tables[table].push(r); return { data: [clone(r)], error: null, __rows: [clone(r)] }; }
      if (op === "update") { const rs = rows(); rs.forEach((r) => Object.assign(r, clone(payload))); return { data: rs.map(clone), error: null, __rows: rs.map(clone) }; }
      if (op === "delete") { const rs = rows(); tables[table] = tables[table].filter((r) => !rs.includes(r)); return { data: null, error: null }; }
      return { data: rows().map(clone), error: null };
    };
    const api = {
      select: () => api, insert: (p) => { op = "insert"; payload = p; return api; },
      upsert: (p, o) => { op = "upsert"; payload = p; conflict = o && o.onConflict; return api; },
      update: (p) => { op = "update"; payload = p; return api; }, delete: () => { op = "delete"; return api; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
      neq: (c, v) => { filters.push((r) => r[c] !== v); return api; },
      in: (c, arr) => { filters.push((r) => arr.includes(r[c])); return api; },
      gte: (c, v) => { filters.push((r) => r[c] >= v); return api; },
      lte: (c, v) => { filters.push((r) => r[c] <= v); return api; },
      order: () => api,
      single: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: rs[0] ? null : { message: "no rows" } }); },
      maybeSingle: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: null }); },
      then: (resolve, reject) => { try { resolve(exec()); } catch (e) { reject(e); } },
    };
    return api;
  }
  return { tables, from, reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; }, seed(t, rs) { (tables[t] = tables[t] || []).push(...rs.map(clone)); } };
});
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })), requirePermission: vi.fn(() => {}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));
const { default: consHandler } = await import("../api/logistics/consolidations.js");
const { default: bidHandler } = await import("../api/logistics/freight_bids.js");

const call = async (handler, { method, query = {}, body }) => {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = JSON.stringify(o); return this; }, send(p) { this.body = p; return this; }, end() { return this; } };
  await handler({ method, headers: {}, query, body }, res);
  let p = null; try { p = res.body ? JSON.parse(res.body) : null; } catch (_) { p = res.body; } return { res, parsed: p };
};

beforeEach(() => H.reset());

describe("POST /api/logistics/consolidations build", () => {
  it("aggregates procurement plans into origin/week consolidations", async () => {
    H.seed("procurement_plans", [
      { id: "pl1", tenant_id: "t-1", part_no: "GUN-1", for_week: "2026-06-08", recommended_qty: 100, status: "approved" },
      { id: "pl2", tenant_id: "t-1", part_no: "STEEL", for_week: "2026-06-08", recommended_qty: 200, status: "draft" },
    ]);
    H.seed("item_master", [
      { tenant_id: "t-1", part_no: "GUN-1", source_country: "O-KOREA", weight_kg: 5, volume_cbm: 0.02 },
      { tenant_id: "t-1", part_no: "STEEL", source_country: "O-INDIA", weight_kg: 100, volume_cbm: 0 },
    ]);
    const { res, parsed } = await call(consHandler, { method: "POST", body: { action: "build", arrival_from: "2026-06-01", arrival_to: "2026-07-01" } });
    expect(res.statusCode).toBe(200);
    expect(parsed.built).toBe(2);
    const korea = H.tables.freight_consolidations.find((c) => c.origin === "O-KOREA");
    expect(korea.weight_kg).toBe(500);            // 100 * 5
    expect(korea.containers.recommended_mode).toBeTruthy();
    expect(korea.plan_ids).toContain("pl1");
    // status defaults to 'open' at the DB layer (column default); the
    // endpoint intentionally omits it from the upsert so re-builds keep
    // an existing bidding/awarded state.
  });
});

describe("freight bids", () => {
  it("records a quote (consolidation -> bidding) and awards one (others rejected)", async () => {
    H.seed("freight_consolidations", [{ id: "con-1", tenant_id: "t-1", status: "open", origin: "O-KOREA" }]);
    const a = await call(bidHandler, { method: "POST", body: { consolidation_id: "con-1", carrier: "Maersk", service: "FCL_40", total_cost: 3200, currency: "USD" } });
    expect(a.res.statusCode).toBe(200);
    expect(H.tables.freight_consolidations[0].status).toBe("bidding");
    const b = await call(bidHandler, { method: "POST", body: { consolidation_id: "con-1", carrier: "MSC", total_cost: 2900, currency: "USD" } });
    // award the cheaper one
    const winnerId = b.parsed.bid.id;
    const aw = await call(bidHandler, { method: "POST", body: { action: "award", id: winnerId } });
    expect(aw.res.statusCode).toBe(200);
    const bids = H.tables.freight_bids;
    expect(bids.find((x) => x.id === winnerId).status).toBe("awarded");
    expect(bids.find((x) => x.carrier === "Maersk").status).toBe("rejected");
    expect(H.tables.freight_consolidations[0].status).toBe("awarded");
  });

  it("requires consolidation_id and carrier", async () => {
    expect((await call(bidHandler, { method: "POST", body: { carrier: "X" } })).res.statusCode).toBe(400);
  });
});
