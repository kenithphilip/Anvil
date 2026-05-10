// BRSR Core Scope 1 / Scope 2 emission math.
//
// Pure-JS computation against the india_emission_factors table.
// Inputs are the typed-in volumes from the supplier-side form
// (kWh, litres, scm); outputs are tCO2e values stored on
// supplier_disclosures.scope1_tco2e / scope2_tco2e.
//
// Scope 2 = market-based grid emissions, net of renewable share:
//   scope2_tco2e = (electricity_kwh / 1000) * grid_tCO2_per_MWh
//                  * (1 - renewable_pct / 100)
//
// Scope 1 = direct combustion, summed across fuel types:
//   scope1_tco2e = (diesel_l * diesel_kg_per_l
//                   + petrol_l * petrol_kg_per_l
//                   + gas_scm * gas_kg_per_scm
//                   + lpg_kg * lpg_kg_per_kg
//                   + coal_kg * coal_kg_per_kg) / 1000
//
// Per SEBI Annexure I and CEA Baseline v21.0 (Nov 2025) for grid;
// DEFRA 2025 GHG Conversion Factors for combustion.
//
// Caller passes a factor map keyed by fuel_type. We don't reach
// into the DB from here; loading the factors is the caller's job
// (the API endpoint queries india_emission_factors once per
// disclosure and threads the map through).

const ELECTRICITY_KWH_PER_MWH = 1000;
const KG_PER_TONNE = 1000;

const finiteNonNeg = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const finitePctClamped = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
};

// Build a quick-access map from a list of india_emission_factors
// rows so the math functions can look up by fuel_type without a
// scan. When multiple rows exist for the same fuel_type (across
// FYs), we pick the row matching `targetFy` if provided, otherwise
// the most recent.
export const buildFactorMap = (rows, targetFy) => {
  const buckets = new Map();
  for (const r of rows || []) {
    if (!r?.fuel_type) continue;
    const list = buckets.get(r.fuel_type) || [];
    list.push(r);
    buckets.set(r.fuel_type, list);
  }
  const out = {};
  for (const [fuel, list] of buckets.entries()) {
    let picked = null;
    if (targetFy) picked = list.find((r) => r.effective_fy === targetFy);
    if (!picked) {
      // Take the row with the lexicographically largest FY string.
      // FY strings are "FY2024-25" / "FY2025-26" so plain sort works.
      list.sort((a, b) => String(a.effective_fy).localeCompare(String(b.effective_fy)));
      picked = list[list.length - 1];
    }
    out[fuel] = {
      factor: Number(picked.factor),
      unit: picked.unit,
      source: picked.source,
      effective_fy: picked.effective_fy,
    };
  }
  return out;
};

// Scope 2 (market-based) from electricity kWh + renewable share.
// Returns { scope2_tco2e, used_factor } where used_factor exposes
// the CEA value applied so the UI can show provenance.
export const computeScope2 = ({ electricity_kwh, electricity_renewable_pct }, factorMap) => {
  const kWh = finiteNonNeg(electricity_kwh);
  if (kWh === 0) return { scope2_tco2e: 0, used_factor: null };
  const gridF = factorMap?.electricity_grid;
  if (!gridF) return { scope2_tco2e: null, used_factor: null };
  const renewablePct = finitePctClamped(electricity_renewable_pct);
  const MWh = kWh / ELECTRICITY_KWH_PER_MWH;
  const tco2e = MWh * gridF.factor * (1 - renewablePct / 100);
  return {
    scope2_tco2e: Math.max(0, Number(tco2e.toFixed(3))),
    used_factor: gridF,
  };
};

// Scope 1 (direct combustion) by summing per-fuel kg-equivalents
// then dividing into tonnes. Returns { scope1_tco2e, breakdown }
// where breakdown is a per-fuel kgCO2e map so the UI can chart it.
export const computeScope1 = ({
  diesel_litres, petrol_litres, natural_gas_scm,
  lpg_kg, coal_kg,
}, factorMap) => {
  const breakdown = {};
  let total_kg = 0;
  const sources = [
    { kind: "diesel",      value: diesel_litres,    factorKey: "diesel" },
    { kind: "petrol",      value: petrol_litres,    factorKey: "petrol" },
    { kind: "natural_gas", value: natural_gas_scm,  factorKey: "natural_gas" },
    { kind: "lpg",         value: lpg_kg,           factorKey: "lpg" },
    { kind: "coal",        value: coal_kg,          factorKey: "coal" },
  ];
  for (const s of sources) {
    const vol = finiteNonNeg(s.value);
    if (vol === 0) continue;
    const f = factorMap?.[s.factorKey];
    if (!f) continue;
    const kg = vol * f.factor;
    breakdown[s.kind] = Number(kg.toFixed(2));
    total_kg += kg;
  }
  const tco2e = total_kg / KG_PER_TONNE;
  return {
    scope1_tco2e: Math.max(0, Number(tco2e.toFixed(3))),
    breakdown,
  };
};

// Convenience: compute both scopes in one pass + an intensity
// ratio per Rs revenue (PPP-adjusted intensity is the caller's
// responsibility; we don't carry the PPP factor in tree).
export const computeAllScopes = (input, factorMap) => {
  const s1 = computeScope1(input, factorMap);
  const s2 = computeScope2(input, factorMap);
  const revenue = finiteNonNeg(input?.revenue_inr);
  const totalTco2e = (s1.scope1_tco2e || 0) + (s2.scope2_tco2e || 0);
  const intensity_per_inr = revenue > 0
    ? Number((totalTco2e / revenue).toFixed(9))
    : null;
  return {
    scope1_tco2e: s1.scope1_tco2e,
    scope2_tco2e: s2.scope2_tco2e,
    total_tco2e: Number(totalTco2e.toFixed(3)),
    scope1_breakdown: s1.breakdown,
    scope2_used_factor: s2.used_factor,
    intensity_per_inr,
  };
};

// Materiality + Scope-3 rollup for the buyer dashboard. For each
// supplier-disclosure row joined to value_chain_relationships,
// compute the spend-weighted contribution to the buyer's Scope 3:
//
//   contribution_tco2e = supplier_scope12_total * (buyer_share_pct / 100)
//
// SEBI's >= 2% materiality is honoured by the SQL filter on the
// caller side; we don't re-filter here. We do enforce the 75%-
// cumulative-coverage rule, returning the cumulative-coverage % so
// the dashboard can render a coverage gauge.
//
// rows shape: [{ scope1_tco2e, scope2_tco2e, buyer_purchase_share_pct, supplier_tenant_id }]
export const rollupBuyerScope3 = (rows) => {
  let totalSpendShare = 0;
  let totalAttributedTco2e = 0;
  const out = [];
  const sorted = (rows || []).slice().sort((a, b) =>
    (Number(b.buyer_purchase_share_pct) || 0) - (Number(a.buyer_purchase_share_pct) || 0),
  );
  let cumulativeShare = 0;
  for (const r of sorted) {
    const share = finiteNonNeg(r.buyer_purchase_share_pct);
    const s1 = finiteNonNeg(r.scope1_tco2e);
    const s2 = finiteNonNeg(r.scope2_tco2e);
    const supplierTotal = s1 + s2;
    const attribution = supplierTotal * (share / 100);
    totalSpendShare += share;
    totalAttributedTco2e += attribution;
    cumulativeShare += share;
    out.push({
      supplier_tenant_id: r.supplier_tenant_id,
      share_pct: share,
      supplier_scope12_tco2e: Number(supplierTotal.toFixed(3)),
      attributed_tco2e: Number(attribution.toFixed(3)),
      cumulative_share_pct: Number(cumulativeShare.toFixed(2)),
      is_material: share >= 2,
      counts_toward_75_pct: cumulativeShare <= 75,
    });
  }
  return {
    rows: out,
    total_attributed_tco2e: Number(totalAttributedTco2e.toFixed(3)),
    total_spend_share_pct: Number(totalSpendShare.toFixed(2)),
    coverage_75_pct_reached: totalSpendShare >= 75,
  };
};

// Test-only exports.
export const __test = {
  finiteNonNeg, finitePctClamped, ELECTRICITY_KWH_PER_MWH, KG_PER_TONNE,
};
