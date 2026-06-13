// Tests for P3 account/supplier-aware pricing: the resolver
// (_lib/pricing-bindings.js) and the CRUD endpoint
// (admin/pricing_profile_bindings.js).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePricingBinding } from "../api/_lib/pricing-bindings.js";

// Resolver mock: a svc whose maybeSingle() returns the matching binding
// from a fixture set, honouring the scope_type/scope_id/is_active eqs.
const svcWith = (bindings) => ({
  from: () => {
    const f = {};
    const api = {
      select: () => api,
      eq: (c, v) => { f[c] = v; return api; },
      maybeSingle: async () => {
        const row = bindings.find((b) =>
          b.scope_type === f.scope_type && b.scope_id === f.scope_id &&
          (f.is_active === undefined || b.is_active === f.is_active));
        return { data: row || null, error: null };
      },
    };
    return api;
  },
});

describe("resolvePricingBinding", () => {
  it("returns the customer binding when present", async () => {
    const svc = svcWith([{ scope_type: "customer", scope_id: "c-1", profile_code: "granular", margin_floor_pct: 0.12, is_active: true }]);
    const out = await resolvePricingBinding(svc, "t-1", { customerId: "c-1", supplierId: "s-1" });
    expect(out).toMatchObject({ profile_code: "granular", margin_floor_pct: 0.12 });
  });

  it("customer wins over supplier", async () => {
    const svc = svcWith([
      { scope_type: "customer", scope_id: "c-1", profile_code: "cust", margin_floor_pct: null, is_active: true },
      { scope_type: "supplier", scope_id: "s-1", profile_code: "supp", margin_floor_pct: null, is_active: true },
    ]);
    const out = await resolvePricingBinding(svc, "t-1", { customerId: "c-1", supplierId: "s-1" });
    expect(out.profile_code).toBe("cust");
  });

  it("falls back to the supplier binding when no customer binding", async () => {
    const svc = svcWith([{ scope_type: "supplier", scope_id: "s-1", profile_code: "supp", margin_floor_pct: null, is_active: true }]);
    const out = await resolvePricingBinding(svc, "t-1", { customerId: "c-1", supplierId: "s-1" });
    expect(out.profile_code).toBe("supp");
  });

  it("returns null when there is no binding", async () => {
    const svc = svcWith([]);
    expect(await resolvePricingBinding(svc, "t-1", { customerId: "c-9" })).toBeNull();
  });

  it("treats a profile-less, floor-less binding as inert (null)", async () => {
    const svc = svcWith([{ scope_type: "customer", scope_id: "c-1", profile_code: null, margin_floor_pct: null, is_active: true }]);
    expect(await resolvePricingBinding(svc, "t-1", { customerId: "c-1" })).toBeNull();
  });
});

// ── Endpoint ──────────────────────────────────────────────────────────
const H = vi.hoisted(() => {
  const tables = {}; let idc = 0;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = []; let op = "select", payload = null, conflict = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "upsert") {
        const keys = (conflict || "").split(",").map((s) => s.trim());
        const ex = keys.length ? tables[table].find((r) => keys.every((k) => r[k] === payload[k])) : null;
        if (ex) { Object.assign(ex, clone(payload)); return { data: [clone(ex)], error: null, __rows: [clone(ex)] }; }
        const row = { id: "id-" + (++idc), ...clone(payload) }; tables[table].push(row); return { data: [clone(row)], error: null, __rows: [clone(row)] };
      }
      if (op === "delete") { const rs = rows(); tables[table] = tables[table].filter((r) => !rs.includes(r)); return { data: null, error: null }; }
      return { data: rows().map(clone), error: null };
    };
    const api = {
      select: () => api, upsert: (p, o) => { op = "upsert"; payload = p; conflict = o && o.onConflict; return api; },
      delete: () => { op = "delete"; return api; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
      order: () => api,
      single: () => { const r = exec(); const rs = r.__rows || r.data || []; return Promise.resolve({ data: rs[0] || null, error: rs[0] ? null : { message: "no rows" } }); },
      then: (resolve, reject) => { try { resolve(exec()); } catch (e) { reject(e); } },
    };
    return api;
  }
  return { tables, from, reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; } };
});
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })), requirePermission: vi.fn(() => {}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));
const { default: handler } = await import("../api/admin/pricing_profile_bindings.js");

const call = async ({ method, query = {}, body }) => {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = JSON.stringify(o); return this; }, send(p) { this.body = p; return this; }, end() { return this; } };
  await handler({ method, headers: {}, query, body }, res);
  let p = null; try { p = res.body ? JSON.parse(res.body) : null; } catch (_) { p = res.body; }
  return { res, parsed: p };
};

describe("/api/admin/pricing_profile_bindings", () => {
  beforeEach(() => H.reset());

  it("upserts a binding and lists it", async () => {
    const a = await call({ method: "POST", body: { scope_type: "customer", scope_id: "c-1", profile_code: "granular", margin_floor_pct: 0.12 } });
    expect(a.res.statusCode).toBe(200);
    expect(a.parsed.binding).toMatchObject({ scope_type: "customer", scope_id: "c-1", profile_code: "granular", margin_floor_pct: 0.12, is_active: true });
    const g = await call({ method: "GET", query: { scope_type: "customer" } });
    expect(g.parsed.bindings).toHaveLength(1);
  });

  it("upsert is idempotent on (scope_type, scope_id)", async () => {
    await call({ method: "POST", body: { scope_type: "customer", scope_id: "c-1", profile_code: "granular" } });
    await call({ method: "POST", body: { scope_type: "customer", scope_id: "c-1", profile_code: "compact" } });
    expect(H.tables.pricing_profile_bindings).toHaveLength(1);
    expect(H.tables.pricing_profile_bindings[0].profile_code).toBe("compact");
  });

  it("rejects a bad scope_type and an empty binding", async () => {
    expect((await call({ method: "POST", body: { scope_type: "vendor", scope_id: "x" } })).res.statusCode).toBe(400);
    expect((await call({ method: "POST", body: { scope_type: "customer", scope_id: "c-1" } })).res.statusCode).toBe(400);
  });
});
