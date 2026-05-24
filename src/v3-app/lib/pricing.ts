// Price-composition engine.
//
// Generalises the per-customer Excel "price composition" sheets (the
// Obara SPARES "multiplication-factor" sheet and the granular
// PROJECT-FOR "new pcompo" sheet) into one deterministic calculator
// usable by any B2B-manufacturing tenant.
//
// A quote line's price is a pipeline:
//
//   supplier_price(FX) -> fx convert -> + overheads (stepwise)
//     = LOADED COST -> margin markup -> SELLING -> discount = FINAL
//
// Both Obara sheets are the same pipeline with a different component
// set: the compact sheet collapses overhead into one loaded FX rate +
// a 30% margin; the granular sheet itemises packing, freight,
// insurance, customs duty, social-welfare tax, CHA, transport and
// install before a 10% margin. The engine reproduces both exactly
// (see pricing.test.ts).
//
// The function is pure and dependency-free so it runs identically on
// the client (live preview) and, when ported, on the server
// (authoritative persistence), and is trivially unit-testable.

export type ComponentKind =
  | "fx_convert" // supplier_price x rate -> sets the running base in base currency
  | "per_unit" // a flat per-unit adder (optionally in supplier currency)
  | "per_weight" // amount x weight_kg
  | "per_volume" // amount x volume_cbm
  | "pct_of" // rate x (a named base) -> additive overhead, e.g. duty, insurance
  | "fixed" // a flat per-unit amount
  | "margin_markup" // running / (1 - rate); captures loaded cost as the pre-markup value
  | "discount"; // running x (1 - rate); customer discount

// Where a component draws the value it scales:
//   "running"        -> the current running subtotal (default)
//   "supplier_base"  -> the fx-converted supplier price, before overhead
//   "<component code>" -> that component's own delta (e.g. SWT on duty)
export type BaseRef = "running" | "supplier_base" | string;

export interface PricingComponent {
  code: string; // unique within a profile; also names this step's outputs
  label: string;
  kind: ComponentKind;
  base?: BaseRef; // for pct_of (and where a non-running base is meant)
  rate?: number; // fraction, for pct_of / margin_markup / discount
  amount?: number; // for per_unit / per_weight / per_volume / fixed
  currency?: "base" | "supplier"; // for amount-based kinds; default "base"
  useLoadedRate?: boolean; // for fx_convert: use the loaded multiplication factor
  enabled?: boolean; // tenant toggle; default true
  visibility?: "internal" | "customer"; // display hint; default "internal"
}

export interface PricingProfile {
  code: string;
  label: string;
  baseCurrency: string; // e.g. "INR"
  components: PricingComponent[];
  marginFloorPct: number; // realized margin must stay at/above this
  fxStaleDays?: number; // warn when the fx snapshot is older than this
}

export interface FxSnapshot {
  base: string; // "INR"
  rates: Record<string, number>; // spot, e.g. { INR: 1, USD: 83.3, CNY: 12, JPY: 0.7 }
  multiplicationFactor?: Record<string, number>; // loaded, e.g. { USD: 129.4, ... }
  asOf?: string; // ISO date, for staleness
}

export interface LineInputs {
  qty: number;
  supplierUnitPrice: number; // in supplierCurrency
  supplierCurrency: string; // "USD" | "JPY" | "CNY" | "INR" | ...
  sourceCountry?: string;
  weightKg?: number;
  volumeCbm?: number;
  discountPct?: number; // per-line override (fraction) for the discount component
  supplierQuoteValidTo?: string; // ISO date; warns when expired
}

export type WarningCode =
  | "below_floor"
  | "below_target"
  | "missing_supplier_price"
  | "missing_fx_rate"
  | "no_loaded_rate"
  | "fx_stale"
  | "supplier_quote_expired"
  | "negative_price";

export interface PricingWarning {
  code: WarningCode;
  severity: "high" | "med" | "low";
  message: string;
}

export interface WaterfallStep {
  code: string;
  label: string;
  kind: ComponentKind;
  base?: BaseRef;
  rate?: number;
  amount?: number;
  inputValue: number; // running before this step
  delta: number; // amount this step added (negative for discount/markup base)
  subtotal: number; // running after this step
  visibility: "internal" | "customer";
}

export interface PriceResult {
  perUnit: {
    supplierBase: number; // fx-converted supplier price
    loadedCost: number; // fully-loaded cost (pre-margin)
    targetSelling: number; // after margin, before discount
    finalPrice: number; // after discount
  };
  lineTotal: number; // finalPrice x qty
  loadedTotal: number; // loadedCost x qty
  marginTarget: number; // fraction (the markup rate)
  marginRealized: number; // (finalPrice - loadedCost) / finalPrice
  effectiveMultiplier: number; // loadedCost / supplierUnitPrice (sanity check)
  waterfall: WaterfallStep[];
  warnings: PricingWarning[];
}

const daysBetween = (iso?: string): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
};

// Evaluate a profile against one line. Pure: no IO, no mutation of args.
export function composePrice(
  profile: PricingProfile,
  line: LineInputs,
  fx: FxSnapshot
): PriceResult {
  const warnings: PricingWarning[] = [];
  const qty = Number(line.qty) || 0;
  const cur = line.supplierCurrency || fx.base;
  const supplier = Number(line.supplierUnitPrice) || 0;
  if (supplier <= 0) {
    warnings.push({ code: "missing_supplier_price", severity: "high", message: "Supplier price is missing or zero." });
  }

  const spot = fx.rates?.[cur];
  if (spot == null && cur !== fx.base) {
    warnings.push({ code: "missing_fx_rate", severity: "high", message: `No exchange rate for ${cur}.` });
  }
  const spotRate = spot != null ? spot : cur === fx.base ? 1 : 1;

  const steps: WaterfallStep[] = [];
  const deltaByCode: Record<string, number> = {};
  const subtotalByCode: Record<string, number> = {};
  let running = 0;
  let supplierBase = 0;
  let loadedCost: number | null = null;
  let marginTarget = 0;

  const enabled = profile.components.filter((c) => c.enabled !== false);

  for (const c of enabled) {
    const before = running;
    let delta = 0;

    if (c.kind === "fx_convert") {
      let rate = spotRate;
      if (c.useLoadedRate) {
        const mf = fx.multiplicationFactor?.[cur];
        if (mf != null) rate = mf;
        else if (cur !== fx.base) {
          warnings.push({ code: "no_loaded_rate", severity: "med", message: `No loaded factor for ${cur}; using spot rate.` });
        }
      }
      const value = supplier * rate;
      delta = value - before; // running was 0 at fx_convert, so delta = value
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
      else if (c.base && c.base !== "running") baseVal = deltaByCode[c.base] ?? 0;
      delta = baseVal * rate;
      running += delta;
    } else if (c.kind === "margin_markup") {
      if (loadedCost == null) loadedCost = running; // first markup pins loaded cost
      marginTarget = Number(c.rate) || 0;
      const after = marginTarget < 1 ? running / (1 - marginTarget) : running;
      delta = after - before;
      running = after;
    } else if (c.kind === "discount") {
      const rate = line.discountPct != null ? Number(line.discountPct) : Number(c.rate) || 0;
      const after = running * (1 - rate);
      delta = after - before; // negative
      running = after;
    }

    deltaByCode[c.code] = delta;
    subtotalByCode[c.code] = running;
    steps.push({
      code: c.code,
      label: c.label,
      kind: c.kind,
      base: c.base,
      rate: c.rate,
      amount: c.amount,
      inputValue: before,
      delta,
      subtotal: running,
      visibility: c.visibility || "internal",
    });
  }

  if (loadedCost == null) loadedCost = running; // no margin component: loaded == final
  const finalPrice = running;
  const targetSelling = loadedCost / (1 - (marginTarget || 0) || 1);
  const marginRealized = finalPrice > 0 ? (finalPrice - loadedCost) / finalPrice : 0;
  const effectiveMultiplier = supplier > 0 ? loadedCost / supplier : 0;

  // Guardrails: the part that protects against profit churn.
  if (finalPrice < 0) {
    warnings.push({ code: "negative_price", severity: "high", message: "Computed price is negative." });
  }
  if (finalPrice > 0 && marginRealized < profile.marginFloorPct) {
    warnings.push({
      code: "below_floor",
      severity: "high",
      message: `Realized margin ${(marginRealized * 100).toFixed(1)}% is below the floor ${(profile.marginFloorPct * 100).toFixed(1)}%.`,
    });
  } else if (finalPrice > 0 && marginTarget > 0 && marginRealized < marginTarget - 1e-9) {
    warnings.push({
      code: "below_target",
      severity: "med",
      message: `Discount pulled realized margin to ${(marginRealized * 100).toFixed(1)}% (target ${(marginTarget * 100).toFixed(1)}%).`,
    });
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
    perUnit: {
      supplierBase: supplierBase || supplier * spotRate,
      loadedCost,
      targetSelling,
      finalPrice,
    },
    lineTotal: finalPrice * qty,
    loadedTotal: loadedCost * qty,
    marginTarget,
    marginRealized,
    effectiveMultiplier,
    waterfall: steps,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Canonical component set + two shipped sample profiles.
//
// v1 ships a fixed, ordered superset of named components; a tenant
// enables the ones it uses and sets the rates. These two profiles
// reproduce the two Obara sheets and double as worked examples.
// ---------------------------------------------------------------------------

// Compact: one loaded FX factor + a flat margin (Obara SPARES sheet).
export const PROFILE_COMPACT: PricingProfile = {
  code: "compact",
  label: "Compact (loaded FX multiplier + margin)",
  baseCurrency: "INR",
  marginFloorPct: 0.15,
  fxStaleDays: 30,
  components: [
    { code: "fx", label: "Landed cost (loaded FX)", kind: "fx_convert", useLoadedRate: true },
    { code: "margin", label: "Margin", kind: "margin_markup", rate: 0.3 },
    { code: "discount", label: "Customer discount", kind: "discount", rate: 0, visibility: "customer" },
  ],
};

// Granular: full import-expense waterfall (Obara PROJECT-FOR sheet).
export const PROFILE_GRANULAR: PricingProfile = {
  code: "granular",
  label: "Granular (itemised import expenses + margin)",
  baseCurrency: "INR",
  marginFloorPct: 0.05,
  fxStaleDays: 30,
  components: [
    { code: "fx", label: "Supplier price in INR", kind: "fx_convert" },
    { code: "packing", label: "Packing", kind: "per_unit", amount: 0, currency: "supplier" },
    { code: "shipping", label: "Shipping", kind: "per_unit", amount: 0, currency: "base" },
    { code: "insurance", label: "Insurance", kind: "pct_of", base: "running", rate: 0.01125 },
    { code: "customs_duty", label: "Basic customs duty", kind: "pct_of", base: "running", rate: 0.1 },
    { code: "social_welfare", label: "Social welfare tax", kind: "pct_of", base: "customs_duty", rate: 0.1 },
    { code: "cha", label: "CHA charges", kind: "pct_of", base: "running", rate: 0.003 },
    { code: "local_transport", label: "Local transportation", kind: "pct_of", base: "running", rate: 0.01 },
    { code: "install_warranty", label: "Install & warranty", kind: "pct_of", base: "running", rate: 0.01 },
    { code: "margin", label: "Margin", kind: "margin_markup", rate: 0.1 },
    { code: "discount", label: "Customer discount", kind: "discount", rate: 0, visibility: "customer" },
  ],
};

export const DEFAULT_PROFILES: PricingProfile[] = [PROFILE_GRANULAR, PROFILE_COMPACT];

// A reasonable default FX snapshot for previews; tenants override.
export const DEFAULT_FX: FxSnapshot = {
  base: "INR",
  rates: { INR: 1, USD: 83.3, CNY: 12, JPY: 0.7 },
  multiplicationFactor: { INR: 1, USD: 129.4, CNY: 18.6, JPY: 1.08 },
  asOf: undefined,
};

export const round0 = (n: number) => Math.round(n);
export const roundUp0 = (n: number) => Math.ceil(n);

// Map a DB row (snake_case, from /api/admin/pricing_profiles) into the
// engine's PricingProfile shape. Components are sorted by seq.
export function pricingProfileFromRow(row: any): PricingProfile {
  const components: PricingComponent[] = (row?.components || [])
    .slice()
    .sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((c: any) => ({
      code: c.code,
      label: c.label || c.code,
      kind: c.kind as ComponentKind,
      base: c.base_ref ?? undefined,
      rate: c.rate != null ? Number(c.rate) : undefined,
      amount: c.amount != null ? Number(c.amount) : undefined,
      currency: c.currency === "supplier" ? "supplier" : "base",
      useLoadedRate: !!c.use_loaded_rate,
      enabled: c.enabled !== false,
      visibility: c.visibility === "customer" ? "customer" : "internal",
    }));
  return {
    code: row?.code,
    label: row?.label || row?.code,
    baseCurrency: row?.base_currency || "INR",
    marginFloorPct: row?.margin_floor_pct != null ? Number(row.margin_floor_pct) : 0.05,
    fxStaleDays: row?.fx_stale_days != null ? Number(row.fx_stale_days) : 30,
    components,
  };
}
