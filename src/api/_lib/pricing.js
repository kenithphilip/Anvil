// Server-side price-composition engine.
//
// Faithful JS port of src/v3-app/lib/pricing.ts (composePrice). Kept in
// lockstep so the price the server persists is authoritative and never
// disagrees with the client preview. Parity is locked by tests that run
// the same regression numbers against both ports.

const KINDS = new Set([
  "fx_convert", "per_unit", "per_weight", "per_volume",
  "pct_of", "fixed", "margin_markup", "discount",
]);

const daysBetween = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
};

// Return a copy of `profile` with per-component overrides applied. The
// override value replaces a per_unit component's amount, or any other
// component's rate (pct_of / margin_markup / discount). Empty/absent => no-op.
export function applyOverrides(profile, overrides) {
  if (!overrides || typeof overrides !== "object" || !Object.keys(overrides).length) return profile;
  return {
    ...profile,
    components: (profile.components || []).map((c) => {
      if (!Object.prototype.hasOwnProperty.call(overrides, c.code)) return c;
      const v = Number(overrides[c.code]);
      if (!Number.isFinite(v)) return c;
      return c.kind === "per_unit" ? { ...c, amount: v } : { ...c, rate: v };
    }),
  };
}

// Pure: evaluate a profile against one line. profile/line/fx mirror the
// TS shapes.
export function composePrice(profile, line, fx) {
  const warnings = [];
  const qty = Number(line.qty) || 0;
  const cur = line.supplierCurrency || fx.base;
  const supplier = Number(line.supplierUnitPrice) || 0;
  if (supplier <= 0) {
    warnings.push({ code: "missing_supplier_price", severity: "high", message: "Supplier price is missing or zero." });
  }

  const spot = fx.rates ? fx.rates[cur] : undefined;
  if (spot == null && cur !== fx.base) {
    warnings.push({ code: "missing_fx_rate", severity: "high", message: `No exchange rate for ${cur}.` });
  }
  const spotRate = spot != null ? spot : 1;

  const steps = [];
  const deltaByCode = {};
  let running = 0;
  let supplierBase = 0;
  let loadedCost = null;
  let marginTarget = 0;

  const enabled = (profile.components || []).filter((c) => c.enabled !== false);

  for (const c of enabled) {
    const before = running;
    let delta = 0;

    if (c.kind === "fx_convert") {
      let rate = spotRate;
      if (c.useLoadedRate) {
        const mf = fx.multiplicationFactor ? fx.multiplicationFactor[cur] : undefined;
        if (mf != null) rate = mf;
        else if (cur !== fx.base) {
          warnings.push({ code: "no_loaded_rate", severity: "med", message: `No loaded factor for ${cur}; using spot rate.` });
        }
      }
      const value = supplier * rate;
      delta = value - before;
      running = value;
      supplierBase = value;
    } else if (c.kind === "per_unit" || c.kind === "fixed") {
      const amt = Number(c.amount) || 0;
      delta = c.currency === "supplier" ? amt * spotRate : amt;
      running += delta;
    } else if (c.kind === "per_weight") {
      const amt = Number(c.amount) || 0;
      const w = Number(line.weightKg) || 0;
      delta = (c.currency === "supplier" ? amt * spotRate : amt) * w;
      running += delta;
    } else if (c.kind === "per_volume") {
      const amt = Number(c.amount) || 0;
      const v = Number(line.volumeCbm) || 0;
      delta = (c.currency === "supplier" ? amt * spotRate : amt) * v;
      running += delta;
    } else if (c.kind === "pct_of") {
      const rate = Number(c.rate) || 0;
      let baseVal = running;
      if (c.base === "supplier_base") baseVal = supplierBase;
      else if (c.base && c.base !== "running") baseVal = deltaByCode[c.base] != null ? deltaByCode[c.base] : 0;
      delta = baseVal * rate;
      running += delta;
    } else if (c.kind === "margin_markup") {
      if (loadedCost == null) loadedCost = running;
      marginTarget = Number(c.rate) || 0;
      const after = marginTarget < 1 ? running / (1 - marginTarget) : running;
      delta = after - before;
      running = after;
    } else if (c.kind === "discount") {
      const rate = line.discountPct != null ? Number(line.discountPct) : Number(c.rate) || 0;
      const after = running * (1 - rate);
      delta = after - before;
      running = after;
    }

    deltaByCode[c.code] = delta;
    steps.push({
      code: c.code, label: c.label, kind: c.kind, base: c.base,
      rate: c.rate, amount: c.amount,
      inputValue: before, delta, subtotal: running,
      visibility: c.visibility || "internal",
    });
  }

  if (loadedCost == null) loadedCost = running;
  const finalPrice = running;
  const targetSelling = loadedCost / ((1 - (marginTarget || 0)) || 1);
  const marginRealized = finalPrice > 0 ? (finalPrice - loadedCost) / finalPrice : 0;
  const effectiveMultiplier = supplier > 0 ? loadedCost / supplier : 0;

  if (finalPrice < 0) {
    warnings.push({ code: "negative_price", severity: "high", message: "Computed price is negative." });
  }
  const floor = Number(profile.marginFloorPct) || 0;
  if (finalPrice > 0 && marginRealized < floor) {
    warnings.push({ code: "below_floor", severity: "high", message: `Realized margin ${(marginRealized * 100).toFixed(1)}% is below the floor ${(floor * 100).toFixed(1)}%.` });
  } else if (finalPrice > 0 && marginTarget > 0 && marginRealized < marginTarget - 1e-9) {
    warnings.push({ code: "below_target", severity: "med", message: `Discount pulled realized margin to ${(marginRealized * 100).toFixed(1)}% (target ${(marginTarget * 100).toFixed(1)}%).` });
  }
  const age = daysBetween(fx.asOf);
  if (age != null && profile.fxStaleDays != null && age > profile.fxStaleDays) {
    warnings.push({ code: "fx_stale", severity: "med", message: `Exchange rates are ${Math.round(age)} days old.` });
  }
  const validAge = daysBetween(line.supplierQuoteValidTo);
  if (validAge != null && validAge > 0) {
    warnings.push({ code: "supplier_quote_expired", severity: "med", message: "Supplier quote validity has expired." });
  }

  return {
    perUnit: { supplierBase: supplierBase || supplier * spotRate, loadedCost, targetSelling, finalPrice },
    lineTotal: finalPrice * qty,
    loadedTotal: loadedCost * qty,
    marginTarget,
    marginRealized,
    effectiveMultiplier,
    waterfall: steps,
    warnings,
  };
}

// Map a DB profile row (with nested components) into the engine shape.
export function mapProfile(row) {
  const components = (row && row.components ? row.components : [])
    .slice()
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map((c) => ({
      code: c.code,
      label: c.label || c.code,
      kind: KINDS.has(c.kind) ? c.kind : "fixed",
      base: c.base_ref || undefined,
      rate: c.rate != null ? Number(c.rate) : undefined,
      amount: c.amount != null ? Number(c.amount) : undefined,
      currency: c.currency === "supplier" ? "supplier" : "base",
      useLoadedRate: !!c.use_loaded_rate,
      enabled: c.enabled !== false,
      visibility: c.visibility === "customer" ? "customer" : "internal",
    }));
  return {
    code: row && row.code,
    label: (row && row.label) || (row && row.code),
    baseCurrency: (row && row.base_currency) || "INR",
    marginFloorPct: row && row.margin_floor_pct != null ? Number(row.margin_floor_pct) : 0.05,
    fxStaleDays: row && row.fx_stale_days != null ? Number(row.fx_stale_days) : 30,
    components,
  };
}
