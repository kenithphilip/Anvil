// The multiply.
//
// Anvil already computes how much raw material a made part consumes -- kg per
// finished unit, derived from the drawing (raw-material-infer.js: grade ->
// density, envelope + machining allowance -> stock form and dimensions, gross
// mass from volume x density, divided by yield). It already resolves what that
// material costs (composition_material_lines.unit_cost, auto-filled from
// material_price_references). Nothing multiplied them, so `unit_cost` had no
// reader anywhere in src/ and the consumption figure never became money.
//
// consumption_per_unit x unit_cost = material cost per finished unit. That is
// the first cost input Anvil can derive for a part the tenant MAKES rather than
// buys -- every other input to composePrice starts from a supplier's price for
// a part somebody else made.
//
// COMPUTED, NEVER STORED. unit_cost tracks a market reference and consumption
// changes whenever the recipe is re-derived; a persisted product of the two
// would be stale the moment either moved, and a stale cost is worse than none.
//
// Pure. No I/O.

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Compare units of measure for the multiply. The price reference is looked up
// BY the line's uom (composition_material_lines.js resolveMaterialPrice passes
// uom: row.uom), so a matched pair agrees by construction -- but a hand-typed
// unit_cost carries no uom of its own, and an operator who prices a tonne
// against a kilogram consumption is out by a thousand with no error. Compare
// only when the caller can state the price's basis.
const sameUom = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// Material cost for ONE finished unit from one recipe line.
//
//   { amount, currency, uom, consumption_per_unit, unit_cost, ok, reason }
//
// `amount` is null whenever the multiply would be a guess; `reason` says which
// half is missing so the UI can ask for the right thing rather than showing a
// confident zero. A zero cost is never inferred from a missing input: a line
// with no price is unpriced, not free.
export const materialCostPerUnit = (line, opts = {}) => {
  const l = line || {};
  const uom = l.uom || "kg";
  const consumption = num(l.consumption_per_unit);
  const unitCost = num(l.unit_cost);
  const out = {
    amount: null,
    currency: l.currency || null,
    uom,
    consumption_per_unit: consumption,
    unit_cost: unitCost,
    ok: false,
    reason: null,
  };
  if (consumption == null) { out.reason = "no_consumption"; return out; }
  if (consumption < 0) { out.reason = "negative_consumption"; return out; }
  if (unitCost == null) { out.reason = "no_unit_cost"; return out; }
  if (unitCost < 0) { out.reason = "negative_unit_cost"; return out; }
  // When the caller knows the price's own unit, refuse a mismatch outright.
  if (opts.priceUom != null && !sameUom(opts.priceUom, uom)) {
    out.reason = "uom_mismatch";
    return out;
  }
  out.amount = Math.round(consumption * unitCost * 10000) / 10000;
  out.ok = true;
  out.reason = "ok";
  return out;
};

// Roll a set of recipe lines up to a material cost per finished unit.
//
// Refuses to add across currencies. Anvil buys raw material in INR and imports
// in USD/JPY/KRW, and a total that silently mixes them is the same class of bug
// as ranking supplier quotes on a raw number while ignoring the currency beside
// it. Mixed input returns per-currency buckets and `mixed_currency: true`, with
// `amount` left null rather than a number nobody should trust.
export const rollUpMaterialCost = (lines, opts = {}) => {
  const rows = Array.isArray(lines) ? lines : [];
  const per = [];
  const byCurrency = new Map();
  let priced = 0;
  let unpriced = 0;
  for (const ln of rows) {
    const c = materialCostPerUnit(ln, opts);
    per.push(c);
    if (!c.ok) { unpriced += 1; continue; }
    priced += 1;
    // An UNLABELLED line is not an INR line. Defaulting a null currency to the
    // tenant's usual one is how a USD rate joins an INR total without ever
    // tripping the mixed-currency refusal below -- and null is the common case,
    // because currency is only set when the market reference carried one.
    // Bucket it as unknown so it forces `mixed_currency` instead of hiding.
    const key = c.currency || "?";
    byCurrency.set(key, (byCurrency.get(key) || 0) + c.amount);
  }
  const buckets = [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 10000) / 10000 }))
    .sort((a, b) => (a.currency < b.currency ? -1 : 1));
  const mixed = buckets.length > 1;
  return {
    lines: per,
    by_currency: buckets,
    mixed_currency: mixed,
    // Single-currency only. A caller wanting one number across currencies must
    // convert deliberately through the FX the quote is priced in.
    amount: mixed || buckets.length === 0 ? null : buckets[0].amount,
    currency: mixed || buckets.length === 0 ? null : buckets[0].currency,
    priced_lines: priced,
    unpriced_lines: unpriced,
    // The honest headline: a total over a partially-priced recipe understates
    // the part, so say so rather than letting it read as complete.
    complete: priced > 0 && unpriced === 0,
  };
};

export const __test = { sameUom, num };
