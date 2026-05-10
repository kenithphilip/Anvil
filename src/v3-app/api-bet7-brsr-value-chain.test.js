// Bet 7 regression tests: BRSR Core value-chain reporting.
//
// Covers:
//   1. emission_factors math: buildFactorMap, computeScope1,
//      computeScope2, computeAllScopes, rollupBuyerScope3.
//   2. Period FY parser + default Apr-Mar window.
//   3. Disclosure writable-fields whitelist (scope1/2 are NOT in
//      it; the client cannot fabricate emissions).
//   4. Relationship invite/accept/reject/revoke share clamping.
//   5. CSV / XBRL stub structure (column order + namespace).
//   6. Source-contract regression: migration columns + CHECK
//      constraints, router wiring, client surface, RBAC entries.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildFactorMap, computeScope1, computeScope2,
  computeAllScopes, rollupBuyerScope3, __test as EF,
} from "../api/_lib/brsr/emission_factors.js";
import { __test as periodTest } from "../api/brsr/period.js";
import { __test as discTest } from "../api/brsr/disclosure.js";
import { __test as relTest } from "../api/brsr/relationship.js";
import { __test as exportTest } from "../api/brsr/buyer/export.js";

const SRC = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// CEA + DEFRA factors matching the seed rows in migration 101.
const FACTOR_ROWS = [
  { fuel_type: "electricity_grid", factor: 0.710,  unit: "tCO2/MWh",     source: "CEA Baseline v21.0", effective_fy: "FY2024-25" },
  { fuel_type: "diesel",           factor: 2.6862, unit: "kgCO2/litre",  source: "DEFRA 2025",         effective_fy: "FY2024-25" },
  { fuel_type: "petrol",           factor: 2.3168, unit: "kgCO2/litre",  source: "DEFRA 2025",         effective_fy: "FY2024-25" },
  { fuel_type: "natural_gas",      factor: 2.0429, unit: "kgCO2/scm",    source: "DEFRA 2025",         effective_fy: "FY2024-25" },
];

// -------------------- emission_factors --------------------------

describe("Bet 7 - emission_factors", () => {
  it("buildFactorMap picks the most recent FY when targetFy is null", () => {
    const map = buildFactorMap([
      { fuel_type: "diesel", factor: 2.5, effective_fy: "FY2023-24" },
      { fuel_type: "diesel", factor: 2.6862, effective_fy: "FY2024-25" },
    ]);
    expect(map.diesel.factor).toBe(2.6862);
    expect(map.diesel.effective_fy).toBe("FY2024-25");
  });

  it("buildFactorMap honors targetFy when supplied", () => {
    const map = buildFactorMap([
      { fuel_type: "diesel", factor: 2.5,   effective_fy: "FY2023-24" },
      { fuel_type: "diesel", factor: 2.6862, effective_fy: "FY2024-25" },
    ], "FY2023-24");
    expect(map.diesel.factor).toBe(2.5);
  });

  it("computeScope2 from kWh + 0% renewable matches the CEA formula", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const { scope2_tco2e } = computeScope2({ electricity_kwh: 100_000, electricity_renewable_pct: 0 }, map);
    // 100,000 kWh = 100 MWh; 100 * 0.710 = 71.000 tCO2e
    expect(scope2_tco2e).toBeCloseTo(71.0, 3);
  });

  it("computeScope2 reduces proportionally with renewable share", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const { scope2_tco2e } = computeScope2({ electricity_kwh: 100_000, electricity_renewable_pct: 25 }, map);
    expect(scope2_tco2e).toBeCloseTo(71.0 * 0.75, 3);
  });

  it("computeScope2 clamps renewable share above 100", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const { scope2_tco2e } = computeScope2({ electricity_kwh: 100_000, electricity_renewable_pct: 250 }, map);
    expect(scope2_tco2e).toBe(0);
  });

  it("computeScope2 returns 0 when electricity_kwh is 0 (no DB hit needed)", () => {
    const { scope2_tco2e, used_factor } = computeScope2({ electricity_kwh: 0 }, {});
    expect(scope2_tco2e).toBe(0);
    expect(used_factor).toBeNull();
  });

  it("computeScope1 sums diesel + petrol + gas with DEFRA factors", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const out = computeScope1({
      diesel_litres: 1000,
      petrol_litres: 500,
      natural_gas_scm: 2000,
    }, map);
    // 1000 * 2.6862 + 500 * 2.3168 + 2000 * 2.0429 = 2686.2 + 1158.4 + 4085.8 = 7930.4 kg = 7.9304 t
    expect(out.scope1_tco2e).toBeCloseTo(7.93, 2);
    expect(out.breakdown.diesel).toBeCloseTo(2686.2, 1);
    expect(out.breakdown.petrol).toBeCloseTo(1158.4, 1);
    expect(out.breakdown.natural_gas).toBeCloseTo(4085.8, 1);
  });

  it("computeScope1 ignores fuels with no factor", () => {
    const partial = buildFactorMap([FACTOR_ROWS[1]], "FY2024-25");      // only diesel
    const out = computeScope1({
      diesel_litres: 1000,
      petrol_litres: 500,
    }, partial);
    expect(out.scope1_tco2e).toBeCloseTo(2.69, 2);
    expect(out.breakdown.petrol).toBeUndefined();
  });

  it("computeScope1 rejects negative volumes (treats as 0)", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const out = computeScope1({ diesel_litres: -500 }, map);
    expect(out.scope1_tco2e).toBe(0);
  });

  it("computeAllScopes builds the intensity per Rs revenue ratio", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const out = computeAllScopes({
      electricity_kwh: 100_000,
      electricity_renewable_pct: 0,
      diesel_litres: 1000,
      revenue_inr: 10_000_000,
    }, map);
    expect(out.scope1_tco2e).toBeCloseTo(2.686, 2);
    expect(out.scope2_tco2e).toBeCloseTo(71.0, 2);
    expect(out.total_tco2e).toBeCloseTo(73.686, 2);
    expect(out.intensity_per_inr).toBeGreaterThan(0);
  });

  it("computeAllScopes returns intensity_per_inr null when revenue is 0", () => {
    const map = buildFactorMap(FACTOR_ROWS, "FY2024-25");
    const out = computeAllScopes({ electricity_kwh: 1000, revenue_inr: 0 }, map);
    expect(out.intensity_per_inr).toBeNull();
  });
});

// -------------------- buyer Scope 3 rollup ----------------------

describe("Bet 7 - rollupBuyerScope3", () => {
  it("attributes supplier emissions by spend-share", () => {
    const out = rollupBuyerScope3([
      { supplier_tenant_id: "a", scope1_tco2e: 100, scope2_tco2e: 50, buyer_purchase_share_pct: 40 },
      { supplier_tenant_id: "b", scope1_tco2e: 200, scope2_tco2e: 100, buyer_purchase_share_pct: 20 },
    ]);
    // a: 150 * 0.40 = 60 ; b: 300 * 0.20 = 60 ; total = 120
    expect(out.total_attributed_tco2e).toBeCloseTo(120, 2);
    expect(out.total_spend_share_pct).toBe(60);
    expect(out.coverage_75_pct_reached).toBe(false);
  });

  it("flags coverage_75_pct_reached when cumulative spend >= 75%", () => {
    const out = rollupBuyerScope3([
      { supplier_tenant_id: "a", scope1_tco2e: 1, scope2_tco2e: 1, buyer_purchase_share_pct: 40 },
      { supplier_tenant_id: "b", scope1_tco2e: 1, scope2_tco2e: 1, buyer_purchase_share_pct: 35 },
    ]);
    expect(out.coverage_75_pct_reached).toBe(true);
  });

  it("sorts rows by share desc so the largest counts first", () => {
    const out = rollupBuyerScope3([
      { supplier_tenant_id: "small", buyer_purchase_share_pct: 1 },
      { supplier_tenant_id: "big", buyer_purchase_share_pct: 50 },
    ]);
    expect(out.rows[0].supplier_tenant_id).toBe("big");
    expect(out.rows[0].cumulative_share_pct).toBe(50);
    expect(out.rows[1].cumulative_share_pct).toBe(51);
  });

  it("marks rows >= 2% as is_material", () => {
    const out = rollupBuyerScope3([
      { supplier_tenant_id: "a", buyer_purchase_share_pct: 2.5 },
      { supplier_tenant_id: "b", buyer_purchase_share_pct: 1.9 },
    ]);
    expect(out.rows[0].is_material).toBe(true);
    expect(out.rows[1].is_material).toBe(false);
  });
});

// -------------------- period parser -----------------------------

describe("Bet 7 - period.parseFy + defaultPeriodFor", () => {
  it("parseFy reads FY2025-26", () => {
    expect(periodTest.parseFy("FY2025-26")).toEqual({ fy: 2025, start: 2025, end: 2026 });
  });

  it("parseFy rejects malformed", () => {
    expect(periodTest.parseFy("2025-26")).toBeNull();
    expect(periodTest.parseFy("FY25-26")).toBeNull();
    expect(periodTest.parseFy(null)).toBeNull();
  });

  it("defaultPeriodFor builds Apr-1 to Mar-31 window for annual", () => {
    const d = periodTest.defaultPeriodFor("FY2025-26", "annual");
    expect(d.period_start).toBe("2025-04-01");
    expect(d.period_end).toBe("2026-03-31");
  });

  it("defaultPeriodFor returns null for quarterly (caller supplies dates)", () => {
    expect(periodTest.defaultPeriodFor("FY2025-26", "quarterly")).toBeNull();
  });
});

// -------------------- disclosure pickWritable -------------------

describe("Bet 7 - disclosure pickWritable whitelist", () => {
  it("drops scope1_tco2e + scope2_tco2e from the client payload", () => {
    const out = discTest.pickWritable({
      electricity_kwh: 1000,
      scope1_tco2e: 999, scope2_tco2e: 999,
      tenant_id: "haxxor",
      id: "haxxor",
    });
    expect(out.electricity_kwh).toBe(1000);
    expect(out.scope1_tco2e).toBeUndefined();
    expect(out.scope2_tco2e).toBeUndefined();
    expect(out.tenant_id).toBeUndefined();
    expect(out.id).toBeUndefined();
  });

  it("retains every documented Annexure I field on the input", () => {
    const fields = [
      "electricity_kwh", "diesel_litres", "petrol_litres", "natural_gas_scm",
      "water_withdrawal_kl", "waste_total_mt", "women_pct_workforce",
      "posh_complaints", "msme_input_pct", "related_party_purchases_pct",
      "wages_paid_to_women_inr", "revenue_inr", "extra",
    ];
    const input = Object.fromEntries(fields.map((f) => [f, 1]));
    const out = discTest.pickWritable(input);
    for (const f of fields) expect(out[f]).toBe(1);
  });
});

// -------------------- relationship validShare -------------------

describe("Bet 7 - relationship.validShare", () => {
  it("clamps below 0 to 0", () => expect(relTest.validShare(-5)).toBe(0));
  it("clamps above 100 to 100", () => expect(relTest.validShare(250)).toBe(100));
  it("passes valid values through", () => expect(relTest.validShare(2.5)).toBe(2.5));
  it("returns null for non-numeric", () => expect(relTest.validShare("abc")).toBeNull());
});

// -------------------- export CSV / XBRL stub --------------------

describe("Bet 7 - buyer/export shape", () => {
  const sampleSuppliers = [
    {
      supplier_tenant_id: "s1", share_pct: 5,
      current_disclosure: {
        scope1_tco2e: 10, scope2_tco2e: 20, electricity_kwh: 1000,
        electricity_renewable_pct: 10, water_withdrawal_kl: 50,
        revenue_inr: 1_000_000,
      },
      prev_disclosure: { scope1_tco2e: 8, scope2_tco2e: 18 },
    },
  ];

  it("ANNEXURE_I sticks to one row per (attribute, parameter, unit)", () => {
    const keys = exportTest.ANNEXURE_I.map((r) => r.sr);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("buildCsv emits Annexure I column order in the header", () => {
    const csv = exportTest.buildCsv({
      suppliers: sampleSuppliers,
      fy: "FY2025-26", prevFy: "FY2024-25", buyerTenantId: "buyer-1",
    });
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toContain("Sr.No.");
    expect(firstLine).toContain("Attribute");
    expect(firstLine).toContain("Parameter");
    expect(firstLine).toContain("Unit");
    expect(firstLine).toContain("FY FY2025-26");
    expect(firstLine).toContain("FY FY2024-25");
  });

  it("buildCsv includes one row per supplier per Annexure entry", () => {
    const csv = exportTest.buildCsv({
      suppliers: sampleSuppliers, fy: "FY2025-26", prevFy: "FY2024-25", buyerTenantId: "buyer-1",
    });
    // header + Annexure rows + buyer-summary row.
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(1 + exportTest.ANNEXURE_I.length + 1);
  });

  it("buildXbrlStub uses the placeholder namespace", () => {
    const xml = exportTest.buildXbrlStub({
      suppliers: sampleSuppliers, fy: "FY2025-26", buyerTenantId: "buyer-1",
    });
    expect(xml).toContain('xmlns:brsr="urn:sebi:brsr-core:2025-stub"');
    expect(xml).toContain("Stub instance");
  });

  it("valueAt computes intensity_total from scope1 + scope2 / revenue", () => {
    const v = exportTest.valueAt(
      { scope1_tco2e: 30, scope2_tco2e: 70, revenue_inr: 10_000_000 },
      { derived: "intensity_total" },
    );
    // 100 / 10e6 = 1.0e-5
    expect(Number(v)).toBeCloseTo(1.0e-5, 9);
  });
});

// -------------------- source-contract regression ---------------

describe("Bet 7 - source contract", () => {
  const migration = SRC("supabase/migrations/101_brsr_value_chain.sql");
  const routerSrc = SRC("src/api/router.js");
  const clientSrc = SRC("src/client/anvil-client.js");
  const navSrc    = SRC("src/v3-app/lib/nav.ts");
  const rbacSrc   = SRC("src/v3-app/lib/rbac.ts");
  const routesSrc = SRC("src/v3-app/routes.ts");

  it("migration creates the three RLS-scoped tables", () => {
    expect(migration).toMatch(/create table if not exists supplier_disclosure_periods/);
    expect(migration).toMatch(/create table if not exists supplier_disclosures/);
    expect(migration).toMatch(/create table if not exists value_chain_relationships/);
    expect(migration).toMatch(/create table if not exists india_emission_factors/);
    expect(migration).toMatch(/enable row level security/);
  });

  it("migration seeds the canonical CEA + DEFRA factors", () => {
    expect(migration).toMatch(/0\.710/);
    expect(migration).toMatch(/CEA Baseline Database v21\.0/);
    expect(migration).toMatch(/2\.6862/);   // DEFRA diesel
    expect(migration).toMatch(/DEFRA 2025/);
  });

  it("migration uses a generated column for is_material at 2%", () => {
    expect(migration).toMatch(/is_material boolean generated always as/);
    expect(migration).toMatch(/>= 2/);
  });

  it("migration includes the buyer-read RLS policy on disclosures", () => {
    expect(migration).toMatch(/sd_buyer_read/);
    expect(migration).toMatch(/consent_status = 'accepted'/);
  });

  it("router exposes all six BRSR endpoints", () => {
    expect(routerSrc).toMatch(/\/brsr\/period/);
    expect(routerSrc).toMatch(/\/brsr\/disclosure/);
    expect(routerSrc).toMatch(/\/brsr\/disclosure\/submit/);
    expect(routerSrc).toMatch(/\/brsr\/prefill/);
    expect(routerSrc).toMatch(/\/brsr\/relationship/);
    expect(routerSrc).toMatch(/\/brsr\/buyer\/dashboard/);
    expect(routerSrc).toMatch(/\/brsr\/buyer\/export/);
  });

  it("anvil-client exposes a brsr object with at least 10 methods", () => {
    expect(clientSrc).toMatch(/brsr = \{/);
    for (const m of [
      "periods:", "createPeriod:", "disclosure:", "saveDisclosure:",
      "submitDisclosure:", "prefill:", "relationships:", "invite:",
      "buyerDashboard:", "exportUrl:",
    ]) {
      expect(clientSrc).toContain(m);
    }
  });

  it("nav and rbac register all three screens", () => {
    expect(navSrc).toMatch(/brsr-supplier/);
    expect(navSrc).toMatch(/brsr-buyer-dashboard/);
    expect(rbacSrc).toMatch(/brsr-supplier/);
    expect(rbacSrc).toMatch(/brsr-buyer-dashboard/);
    expect(rbacSrc).toMatch(/brsr-disclosure-detail/);
    expect(routesSrc).toMatch(/brsrSupplier/);
    expect(routesSrc).toMatch(/brsrBuyerDashboard/);
    expect(routesSrc).toMatch(/brsrDisclosureDetail/);
  });
});

// -------------------- internal helpers --------------------------

describe("Bet 7 - helpers", () => {
  it("finiteNonNeg clamps negatives + non-finite to 0", () => {
    expect(EF.finiteNonNeg(-5)).toBe(0);
    expect(EF.finiteNonNeg("x")).toBe(0);
    expect(EF.finiteNonNeg(2.5)).toBe(2.5);
  });

  it("finitePctClamped bounds to [0, 100]", () => {
    expect(EF.finitePctClamped(-1)).toBe(0);
    expect(EF.finitePctClamped(150)).toBe(100);
    expect(EF.finitePctClamped(50)).toBe(50);
  });
});
