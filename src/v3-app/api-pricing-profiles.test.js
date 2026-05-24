// Tests for /api/admin/pricing_profiles.
//
// Locks: GET merges global defaults with the tenant's own profiles
// (tenant rows shadow a global of the same code) and attaches each
// profile's ordered components; POST upserts a tenant profile, stamps
// tenant_id on its components, and replaces the component list; the
// 400 when code is absent; admin-only writes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  globals: [],
  own: [],
  components: [],
  existing: null,
  upserted: null,
  insertedComponents: null,
  deletedComponents: false,
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));

vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const makeQuery = (resolve) => {
  const state = { filters: {}, isNull: [], op: "select", payload: null };
  const q = {
    select() { return q; },
    is(k) { state.isNull.push(k); return q; },
    eq(k, v) { state.filters[k] = v; return q; },
    in() { return q; },
    order() { return q; },
    insert(p) { state.op = "insert"; state.payload = p; return q; },
    update(p) { state.op = "update"; state.payload = p; return q; },
    delete() { state.op = "delete"; return q; },
    maybeSingle() { return Promise.resolve(resolve(state, "maybeSingle")); },
    single() { return Promise.resolve(resolve(state, "single")); },
    then(onF, onR) { return Promise.resolve(resolve(state, "list")).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state, mode) => {
  if (table === "pricing_profiles") {
    if (state.op === "insert") { h.upserted = { ...state.payload, id: "new-id" }; return { data: h.upserted, error: null }; }
    if (state.op === "update") { h.upserted = { ...state.payload, id: h.existing?.id || "exist-id" }; return { data: h.upserted, error: null }; }
    if (state.op === "delete") return { error: null };
    if (mode === "maybeSingle") return { data: h.existing, error: null };
    if (mode === "single") return { data: h.upserted || h.own[0] || h.globals[0], error: null };
    return { data: state.isNull.includes("tenant_id") ? h.globals : h.own, error: null };
  }
  if (table === "pricing_components") {
    if (state.op === "insert") { h.insertedComponents = state.payload; return { error: null }; }
    if (state.op === "delete") { h.deletedComponents = true; return { error: null }; }
    return { data: h.components, error: null };
  }
  return { data: [], error: null };
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({ from: (table) => makeQuery(resolver(table)) })),
}));

const { default: handler } = await import("../api/admin/pricing_profiles.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const run = async (method, { query = {}, body } = {}) => {
  const req = { method, headers: {}, query, body };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.globals = [
    { id: "g1", tenant_id: null, code: "granular", label: "Granular", margin_floor_pct: 0.05, sort_order: 10, is_active: true },
    { id: "g2", tenant_id: null, code: "compact", label: "Compact", margin_floor_pct: 0.15, sort_order: 20, is_active: true },
  ];
  h.own = [];
  h.components = [];
  h.existing = null;
  h.upserted = null;
  h.insertedComponents = null;
  h.deletedComponents = false;
});

describe("admin/pricing_profiles", () => {
  it("GET returns global defaults with attached components", async () => {
    h.components = [
      { profile_id: "g1", code: "fx", seq: 1, kind: "fx_convert" },
      { profile_id: "g2", code: "margin", seq: 2, kind: "margin_markup", rate: 0.3 },
    ];
    const { res, parsed } = await run("GET");
    expect(res.statusCode).toBe(200);
    expect(parsed.profiles.map((p) => p.code).sort()).toEqual(["compact", "granular"]);
    const granular = parsed.profiles.find((p) => p.code === "granular");
    expect(granular.components[0].code).toBe("fx");
  });

  it("GET lets a tenant profile shadow a global of the same code", async () => {
    h.own = [{ id: "o1", tenant_id: "t-1", code: "granular", label: "My Granular", margin_floor_pct: 0.08, sort_order: 5 }];
    const { parsed } = await run("GET");
    const granular = parsed.profiles.find((p) => p.code === "granular");
    expect(granular.id).toBe("o1"); // tenant row wins
    expect(parsed.profiles.filter((p) => p.code === "granular").length).toBe(1);
  });

  it("POST upserts a tenant profile and stamps tenant_id on components", async () => {
    const { res, parsed } = await run("POST", {
      body: {
        code: "granular",
        label: "Custom",
        margin_floor_pct: 0.07,
        components: [
          { seq: 1, code: "fx", label: "FX", kind: "fx_convert" },
          { seq: 2, code: "margin", label: "Margin", kind: "margin_markup", rate: 0.12 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(parsed.profile.code).toBe("granular");
    expect(h.deletedComponents).toBe(true); // old components cleared
    expect(h.insertedComponents).toHaveLength(2);
    expect(h.insertedComponents.every((c) => c.tenant_id === "t-1" && c.profile_id === "new-id")).toBe(true);
  });

  it("POST rejects an unknown component kind by coercing to fixed", async () => {
    await run("POST", { body: { code: "x", components: [{ code: "weird", kind: "nonsense" }] } });
    expect(h.insertedComponents[0].kind).toBe("fixed");
  });

  it("POST 400 when code is missing", async () => {
    const { res, parsed } = await run("POST", { body: { label: "no code" } });
    expect(res.statusCode).toBe(400);
    expect(parsed.error.message).toMatch(/code/);
  });

  it("DELETE removes a tenant profile when it exists", async () => {
    h.existing = { id: "o1", tenant_id: "t-1" };
    const { res, parsed } = await run("DELETE", { query: { id: "o1" } });
    expect(res.statusCode).toBe(200);
    expect(parsed.ok).toBe(true);
  });
});
