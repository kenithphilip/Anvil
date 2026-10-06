// Cost and margin are visible only to the roles in cost.view.
//
// Every endpoint below used to check only the coarse "read" (or "write") verb,
// which admits every signed-in role, so a viewer, an operator or a design
// engineer could read the supplier price, landed cost and margin tiers of any
// quote. auth.js is the REAL module here (only resolveContext is replaced), so
// these tests exercise the SERVER_ACTIONS entry itself, not a stand-in.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, tables: {}, writes: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

// Enough of the PostgREST builder for these handlers. Reads return the rows
// in H.tables[table] (filters are not applied: each test seeds only what it
// reads); writes are recorded in H.writes and echo the row back.
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: (table) => {
      let single = false;
      let write = null;
      const q = {
        select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, not: () => q,
        gte: () => q, lte: () => q, gt: () => q, lt: () => q, or: () => q, ilike: () => q,
        order: () => q, limit: () => q, range: () => q,
        maybeSingle: () => { single = true; return q; },
        single: () => { single = true; return q; },
        upsert: (row) => { write = row; H.writes.push({ table, mode: "upsert", row }); return q; },
        insert: (row) => { write = row; H.writes.push({ table, mode: "insert", row }); return q; },
        update: (row) => { write = row; H.writes.push({ table, mode: "update", row }); return q; },
        delete: () => { write = {}; H.writes.push({ table, mode: "delete" }); return q; },
        then: (resolve, reject) => {
          const rows = write ? [write] : (H.tables[table] || []);
          return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  }),
}));

const { SERVER_ACTIONS } = await import("../api/_lib/auth.js");
const { ACTIONS } = await import("./lib/rbac");
const { default: priceComposition } = await import("../api/admin/price_composition_lines.js");
const { default: materialLines } = await import("../api/admin/composition_material_lines.js");
const { default: marginHistory } = await import("../api/cost/margin_history.js");
const { default: pricingProfiles } = await import("../api/admin/pricing_profiles.js");
const { default: pricingSettings } = await import("../api/admin/tenant_pricing_settings.js");
const { default: quoteApprovals } = await import("../api/admin/quote_approvals.js");
const { default: anomalyCompute } = await import("../api/anomaly/compute.js");

const as = (role) => { H.ctx = { user: { id: "u-" + role }, tenantId: "t-1", role }; };

const call = async (handler, { method = "GET", query = {}, body } = {}) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end() { return this; },
  };
  await handler({ method, headers: {}, query, body }, res);
  const parsed = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return { status: res.statusCode, body: parsed };
};

const COST_LINE = { id: "pc-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, part_no: "P-1", supplier_unit_price: 70, landed_cost: 84, mod1: 0.05, selling_unit_price: 100 };

beforeEach(() => {
  H.tables = {};
  H.writes = [];
});

describe("cost.view is registered on both sides with the same roles", () => {
  it("lists sales_engineer, sales_manager, finance and admin, and nobody else", () => {
    // A name missing from SERVER_ACTIONS admits every role (hasAction returns
    // true for an unknown action), so the registration is the gate.
    expect([...SERVER_ACTIONS["cost.view"]].sort()).toEqual(["admin", "finance", "sales_engineer", "sales_manager"]);
    expect([...ACTIONS["cost.view"]].sort()).toEqual(["admin", "finance", "sales_engineer", "sales_manager"]);
  });
});

describe("Price Compo lines", () => {
  for (const role of ["viewer", "operator", "procurement", "design_engineer", "design_manager", "customer_support"]) {
    it(`refuses ${role} on read`, async () => {
      as(role);
      H.tables.price_composition_lines = [COST_LINE];
      const r = await call(priceComposition, { query: { quote_id: "q-1" } });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("84");
    });
  }

  for (const role of ["sales_engineer", "sales_manager", "finance", "admin"]) {
    it(`returns the lines to ${role}`, async () => {
      as(role);
      H.tables.price_composition_lines = [COST_LINE];
      const r = await call(priceComposition, { query: { quote_id: "q-1" } });
      expect(r.status).toBe(200);
      expect(r.body.lines[0].landed_cost).toBe(84);
    });
  }

  it("refuses a writer outside cost.view, and writes nothing", async () => {
    as("procurement");
    const r = await call(priceComposition, { method: "POST", body: { quote_id: "q-1", lines: [{ line_index: 0, mod3: 0.5 }] } });
    expect(r.status).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("lets a sales engineer save a line", async () => {
    as("sales_engineer");
    const r = await call(priceComposition, { method: "POST", body: { quote_id: "q-1", lines: [{ line_index: 0, mod3: 0.5 }] } });
    expect(r.status).toBe(200);
    expect(H.writes.find((w) => w.table === "price_composition_lines").row.mod3).toBe(0.5);
  });

  it("refuses an operator on delete, and deletes nothing", async () => {
    as("operator");
    const r = await call(priceComposition, { method: "DELETE", query: { id: "pc-1" } });
    expect(r.status).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

describe("raw-material cost lines", () => {
  it("refuses a viewer", async () => {
    as("viewer");
    H.tables.composition_material_lines = [{ id: "m-1", quote_id: "q-1", unit_cost: 412 }];
    const r = await call(materialLines, { query: { quote_id: "q-1" } });
    expect(r.status).toBe(403);
  });

  it("returns them to finance", async () => {
    as("finance");
    H.tables.composition_material_lines = [{ id: "m-1", quote_id: "q-1", composition_line_index: 0, seq: 0, raw_material_part_no: "RM-1", unit_cost: 412, consumption_per_unit: 1 }];
    const r = await call(materialLines, { query: { quote_id: "q-1" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("412");
  });
});

describe("margin history, pricing profiles, pricing settings", () => {
  it("refuses procurement the customer's margin history, and answers a sales manager", async () => {
    as("procurement");
    expect((await call(marginHistory, { query: { customer_id: "c-1" } })).status).toBe(403);
    as("sales_manager");
    const ok = await call(marginHistory, { query: { customer_id: "c-1" } });
    expect(ok.status).toBe(200);
    expect(ok.body.sample).toBe(0);
  });

  it("refuses a viewer the pricing profiles (markup rates), and answers a sales engineer", async () => {
    as("viewer");
    expect((await call(pricingProfiles)).status).toBe(403);
    as("sales_engineer");
    expect((await call(pricingProfiles)).status).toBe(200);
  });

  it("refuses an operator the margin floor settings, and answers admin", async () => {
    as("operator");
    H.tables.tenant_pricing_settings = [{ tenant_id: "t-1", target_margin: 0.22 }];
    expect((await call(pricingSettings)).status).toBe(403);
    as("admin");
    expect((await call(pricingSettings)).status).toBe(200);
  });
});

describe("the approvals queue", () => {
  // Selling 2 x 100 = 200, landed 2 x 70 = 140: margin 30%.
  const seed = () => {
    H.tables.quote_approvals = [{
      id: "ap-1", order_id: "ord-1", status: "PENDING",
      order: {
        po_number: "PO-9", order_mode: "SPARES",
        result: {
          salesOrder: { grandTotal: 236, lineItems: [{ sellerPartNo: "A", qty: 2, rate: 100 }] },
          priceComposition: { lineItems: [{ partNumber: "A", landedCostINR: 70 }] },
        },
        customer: { customer_name: "Fixture Co" },
      },
    }];
  };

  it("shows a viewer the row but not its margin, and says the margin is hidden", async () => {
    as("viewer");
    seed();
    const r = await call(quoteApprovals, { query: { type: "approvals" } });
    expect(r.status).toBe(200);
    const row = r.body.approvals[0];
    expect(row.po_number).toBe("PO-9");
    expect(row.value_inr).toBe(236);
    expect(row.margin_pct).toBeNull();
    expect(row.margin_state).toBe("hidden");
    expect(row.margin_lines_total).toBeNull();
  });

  it("shows a sales manager the margin", async () => {
    as("sales_manager");
    seed();
    const row = (await call(quoteApprovals, { query: { type: "approvals" } })).body.approvals[0];
    expect(row.margin_pct).toBeCloseTo(30, 5);
    expect(row.margin_state).toBe("computed");
  });
});

describe("anomaly checks", () => {
  // Rate 100 against a landed cost of 120: below cost, margin -20%.
  const body = {
    customerId: "c-1",
    candidate: {
      lineItems: [{ sellerPartNo: "A", qty: 1, rate: 100 }],
      _priceComposition: { lineItems: [{ partNumber: "A", landedCostINR: 120 }] },
    },
  };
  const keys = (r) => r.body.flags.map((f) => f.key);

  it("runs the cost and margin rules for finance", async () => {
    as("finance");
    const r = await call(anomalyCompute, { method: "POST", body });
    expect(r.status).toBe(200);
    expect(keys(r)).toContain("margin_floor_breach");
    expect(keys(r)).toContain("rate_below_landed_cost");
  });

  it("does not run them for procurement, so no landed cost or margin is printed", async () => {
    as("procurement");
    const r = await call(anomalyCompute, { method: "POST", body });
    expect(r.status).toBe(200);
    expect(keys(r)).not.toContain("margin_floor_breach");
    expect(keys(r)).not.toContain("rate_below_landed_cost");
    expect(JSON.stringify(r.body.flags)).not.toMatch(/landed/i);
  });
});
