// Per-line tax and total math, shared between the recon table cell
// renderer and the table-footer aggregator so the displayed sum
// always matches the sum of displayed line totals (no paise drift).
//
// Three input paths are supported, in priority order:
//
//   1. Explicit per-component PER-UNIT amounts. This is the
//      Hyundai-PO shape: each line carries CGST, SGST, IGST,
//      UTGST, cess, excise duty, ed.cess, plus auxiliary costs
//      tooling / P&F / others. When ANY of these is set the
//      line's tax + line total are computed from them and
//      `rate` is treated as the tax-exclusive ex-price.
//
//   2. gst_pct legacy fast-path. The pre-May-2026 shape:
//      `rate` is the ex-price and `gst_pct` carries the
//      consolidated GST rate as a percentage. Tax = qty * rate
//      * pct / 100. No auxiliary costs.
//
//   3. lineTotal passthrough. If neither of the above is set
//      but the upstream extractor provided a lineTotal, derive
//      tax from (lineTotal - taxable) so we don't lose value.
//
// All component values are interpreted as PER-UNIT amounts, the
// same way Hyundai's PO prints SGST 4,229.190 next to a 2-unit
// row and a 110,898.760 line total: per-unit, not per-line.

export interface TaxBreakdown {
  // GST family. Intrastate splits between CGST + SGST; interstate
  // uses IGST; UT-administered uses UTGST. The compute helper
  // sums whichever are set without enforcing the split rule;
  // policing the mix is left to the validation step.
  cgst_amount?: number;
  sgst_amount?: number;
  igst_amount?: number;
  utgst_amount?: number;
  // Cess and pre-GST levies still appear on some POs (heavy
  // industrial, tobacco-adjacent SKUs, transitional regimes).
  cess_amount?: number;
  excise_amount?: number;
  ed_cess_amount?: number;
  // Auxiliary line costs the buyer expects passed through
  // separately from the tax math.
  tooling_amount?: number;
  p_and_f_amount?: number;
  others_amount?: number;
}

export interface LineTotals {
  qty: number;
  rate: number;        // tax-exclusive unit price (ex-price)
  taxable: number;     // qty * rate
  tax: number;         // qty * sum(per-unit tax components) OR qty * rate * pct / 100
  aux: number;         // qty * sum(per-unit auxiliary components)
  lineTotal: number;   // taxable + tax + aux
  source: "explicit" | "gst_pct" | "lineTotal" | "none";
  components: TaxBreakdown;
}

export const TAX_AMOUNT_KEYS = [
  "cgst_amount",
  "sgst_amount",
  "igst_amount",
  "utgst_amount",
  "cess_amount",
  "excise_amount",
  "ed_cess_amount",
] as const;

export const AUX_AMOUNT_KEYS = [
  "tooling_amount",
  "p_and_f_amount",
  "others_amount",
] as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const readNum = (line: Record<string, unknown>, key: string): number => {
  const v = line[key];
  const n = typeof v === "number" ? v : Number(v as string);
  return Number.isFinite(n) ? n : 0;
};

export const computeLineTotals = (line: Record<string, unknown> | null | undefined): LineTotals => {
  const ln = line || {};
  const qty = Number(ln.qty ?? ln.quantity ?? 0) || 0;
  const rate = Number(ln.rate ?? ln.unitPrice ?? 0) || 0;
  const taxable = round2(qty * rate);

  // Path 1: explicit per-component tax + aux amounts.
  let hasExplicit = false;
  let taxPerUnit = 0;
  let auxPerUnit = 0;
  const components: TaxBreakdown = {};
  for (const k of TAX_AMOUNT_KEYS) {
    const v = readNum(ln, k);
    if (v > 0) {
      (components as Record<string, number>)[k] = v;
      taxPerUnit += v;
      hasExplicit = true;
    }
  }
  for (const k of AUX_AMOUNT_KEYS) {
    const v = readNum(ln, k);
    if (v > 0) {
      (components as Record<string, number>)[k] = v;
      auxPerUnit += v;
      hasExplicit = true;
    }
  }
  if (hasExplicit) {
    const tax = round2(qty * taxPerUnit);
    const aux = round2(qty * auxPerUnit);
    const lineTotal = round2(taxable + tax + aux);
    return { qty, rate, taxable, tax, aux, lineTotal, source: "explicit", components };
  }

  // Path 2: gst_pct legacy fast-path.
  const gstPct = Number(ln.gst_pct ?? ln.gstRate ?? ln.rate_of_duty_pct ?? 0) || 0;
  if (gstPct > 0) {
    const tax = round2((taxable * gstPct) / 100);
    const lineTotal = round2(taxable + tax);
    return { qty, rate, taxable, tax, aux: 0, lineTotal, source: "gst_pct", components: {} };
  }

  // Path 3: explicit lineTotal passthrough. Derive tax as the
  // remainder so we do not silently drop value from the
  // extractor's reported total.
  const lineTotalProvided = Number(ln.lineTotal ?? 0) || 0;
  if (lineTotalProvided > 0) {
    return {
      qty, rate, taxable,
      tax: round2(Math.max(0, lineTotalProvided - taxable)),
      aux: 0,
      lineTotal: round2(lineTotalProvided),
      source: "lineTotal",
      components: {},
    };
  }

  return { qty, rate, taxable, tax: 0, aux: 0, lineTotal: taxable, source: "none", components: {} };
};

// Per-unit-tax label map for the UI: every component shows up
// with a short, recognisable label. Kept here so the recon
// table and any future tax-summary view read the same strings.
export const COMPONENT_LABEL: Record<keyof TaxBreakdown, string> = {
  cgst_amount: "CGST",
  sgst_amount: "SGST",
  igst_amount: "IGST",
  utgst_amount: "UTGST",
  cess_amount: "Cess",
  excise_amount: "Excise duty",
  ed_cess_amount: "Ed. cess",
  tooling_amount: "Tooling",
  p_and_f_amount: "P&F",
  others_amount: "Others",
};
