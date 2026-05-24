// Tests for the server-side pricing engine port + the recompute path of
// /api/admin/price_composition_lines.
//
// Locks: (1) the JS port (api/_lib/pricing.js) reproduces the same
// spreadsheet numbers as the TS engine, so client preview and server
// persistence never disagree; (2) the recompute handler resolves the
// tenant profile, recomputes server-side, and persists the authoritative
// landed cost / selling price / realized margin (never trusts client
// totals); (3) tenant scoping, the 400s, and the missing-profile 404.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { composePrice, mapProfile } from "../api/_lib/pricing.js";

// DB-shaped component rows for the canonical granular + compact profiles.
const GRANULAR_ROW = {
  code: "granular", label: "Granular", base_currency: "INR", margin_floor_pct: 0.05, fx_stale_days: 30,
  components: [
    { seq: 1, code: "fx", label: "Supplier price in INR", kind: "fx_convert" },
    { seq: 2, code: "packing", label: "Packing", kind: "per_unit", amount: 150, currency: "supplier" },
    { seq: 3, code: "shipping", label: "Shipping", kind: "per_unit", amount: 50000, currency: "base" },
    { seq: 4, code: "insurance", label: "Insurance", kind: "pct_of", base_ref: "running", rate: 0.01125 },
    { seq: 5, code: "customs_duty", label: "Customs duty", kind: "pct_of", base_ref: "running", rate: 0.1 },
    { seq: 6, code: "social_welfare", label: "SWT", kind: "pct_of", base_ref: "customs_duty", rate: 0.1 },
    { seq: 7, code: "cha", label: "CHA", kind: "pct_of", base_ref: "running", rate: 0.003 },
    { seq: 8, code: "local_transport", label: "Transport", kind: "pct_of", base_ref: "running", rate: 0.01 },
    { seq: 9, code: "install_warranty", label: "Install", kind: "pct_of", base_ref: "running", rate: 0.01 },
    { seq: 10, code: "margin", label: "Margin", kind: "margin_markup", rate: 0.1 },
    { seq: 11, code: "discount", label: "Discount", kind: "discount", rate: 0, visibility: "customer" },
  ],
};
const COMPACT_ROW = {
  code: "compact", label: "Compact", base_currency: "INR", margin_floor_pct: 0.15, fx_stale_days: 30,
  components: [
    { seq: 1, code: "fx", label: "Landed (loaded FX)", kind: "fx_convert", use_loaded_rate: true },
    { seq: 2, code: "margin", label: "Margin", kind: "margin_markup", rate: 0.3 },
    { seq: 3, code: "discount", label: "Discount", kind: "discount", rate: 0, visibility: "customer" },
  ],
};

describe("api/_lib/pricing — port parity with the spreadsheet", () => {
  it("granular reproduces loaded 837,124.72 and selling 930,138.57", () => {
    const r = composePrice(mapProfile(GRANULAR_ROW), { qty: 1, supplierUnitPrice: 8000, supplierCurrency: "USD" }, { base: "INR", rates: { INR: 1, USD: 83.3 } });
    expect(r.perUnit.loadedCost).toBeCloseTo(837124.72, 1);
    expect(r.perUnit.finalPrice).toBeCloseTo(930138.57, 1);
  });
  it("compact reproduces landed 109.99 and rounded selling 158", () => {
    const fx = { base: "INR", rates: { INR: 1, USD: 83.3 }, multiplicationFactor: { USD: 129.4 } };
    const r = composePrice(mapProfile(COMPACT_ROW), { qty: 1, supplierUnitPrice: 0.85, supplierCurrency: "USD" }, fx);
    expect(r.perUnit.loadedCost).toBeCloseTo(109.99, 2);
    expect(Math.ceil(r.perUnit.finalPrice)).toBe(158);
  });
});

// ---- handler recompute path ----

const h = vi.hoisted(() => ({ ownProfile: null, globalProfile: null, components: [], upserts: [] }));

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
    order() { return q; },
    upsert(p) { state.op = "upsert"; state.payload = p; return q; },
    maybeSingle() { return Promise.resolve(resolve(state, "maybeSingle")); },
    single() { return Promise.resolve(resolve(state, "single")); },
    then(onF, onR) { return Promise.resolve(resolve(state, "list")).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state, mode) => {
  if (table === "pricing_profiles") {
    if (mode === "maybeSingle") return { data: state.isNull.includes("tenant_id") ? h.globalProfile : h.ownProfile, error: null };
    return { data: [], error: null };
  }
  if (table === "pricing_components") return { data: h.components, error: null };
  if (table === "price_composition_lines") {
    if (state.op === "upsert") { h.upserts.push(state.payload); return { data: state.payload, error: null }; }
    return { data: [], error: null };
  }
  return { data: [], error: null };
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({ from: (table) => makeQuery(resolver(table)) })),
}));

const { default: handler } = await import("../api/admin/price_composition_lines.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const run = async (body, query = { action: "recompute" }) => {
  const req = { method: "POST", headers: {}, query, body };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.ownProfile = null;
  h.globalProfile = { id: "g1", tenant_id: null, code: "granular", label: "Granular", base_currency: "INR", margin_floor_pct: 0.05, fx_stale_days: 30 };
  h.components = GRANULAR_ROW.components;
  h.upserts = [];
});

describe("admin/price_composition_lines — recompute", () => {
  it("recomputes + persists the authoritative landed cost and selling price", async () => {
    const { res, parsed } = await run({
      quote_id: "q-1",
      profile_code: "granular",
      fx: { base: "INR", rates: { INR: 1, USD: 83.3 } },
      lines: [{ line_index: 0, part_no: "X", qty: 1, supplier_unit_price: 8000, supplier_currency: "USD" }],
    });
    expect(res.statusCode).toBe(200);
    expect(h.upserts).toHaveLength(1);
    const row = h.upserts[0];
    expect(row.tenant_id).toBe("t-1");
    expect(row.profile_code).toBe("granular");
    expect(row.landed_cost).toBeCloseTo(837124.72, 1);
    expect(row.selling_unit_price).toBeCloseTo(930138.57, 1);
    expect(row.margin_floor).toBe(0.05);
    expect(Array.isArray(row.waterfall)).toBe(true);
  });

  it("ignores any client-sent total and uses the engine result", async () => {
    const { parsed } = await run({
      quote_id: "q-1",
      profile_code: "granular",
      fx: { base: "INR", rates: { INR: 1, USD: 83.3 } },
      lines: [{ line_index: 0, qty: 1, supplier_unit_price: 8000, supplier_currency: "USD", selling_unit_price: 1, landed_cost: 1 }],
    });
    expect(h.upserts[0].selling_unit_price).toBeCloseTo(930138.57, 1); // not the bogus 1
  });

  it("falls back to the global profile when the tenant has none", async () => {
    h.ownProfile = null; // own lookup returns nothing -> global used
    const { res } = await run({
      quote_id: "q-1", profile_code: "granular",
      fx: { base: "INR", rates: { INR: 1, USD: 83.3 } },
      lines: [{ line_index: 0, qty: 1, supplier_unit_price: 100, supplier_currency: "USD" }],
    });
    expect(res.statusCode).toBe(200);
    expect(h.upserts[0].profile_code).toBe("granular");
  });

  it("404 when the profile cannot be resolved", async () => {
    h.globalProfile = null;
    const { res, parsed } = await run({
      quote_id: "q-1", profile_code: "ghost",
      lines: [{ line_index: 0, qty: 1, supplier_unit_price: 100, supplier_currency: "USD" }],
    });
    expect(res.statusCode).toBe(404);
    expect(parsed.error.message).toMatch(/profile/i);
  });

  it("400 when profile_code is missing", async () => {
    const { res } = await run({ quote_id: "q-1", lines: [{ line_index: 0, qty: 1, supplier_unit_price: 100 }] });
    expect(res.statusCode).toBe(400);
  });
});
