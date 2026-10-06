// Filling item_master.weight_kg from documents the tenant already uploads.
//
// weight_kg has existed since migration 145 and is entirely empty — 1,000
// items sampled from live data, zero with a weight — because nothing in the
// product can write one. So freight is apportioned by line value instead of by
// weight, and the container estimator returns "none" for every real plan.
//
// The alternative to a data-entry campaign across thousands of parts is to
// take the weight from the page when a supplier prints one. This is that.
//
// FOUR REFUSALS, because a wrong weight is invisible. It is stored once and
// then silently mis-apportions freight on every future quote for that part —
// no screen shows it, no check catches it.
//
//   1. Only ever fills a BLANK. A weight already on the master is
//      authoritative; a document never overwrites it.
//   2. Only with an unambiguous BASIS. "per_unit" or "line_total" — if the
//      extractor could not tell which, the value is dropped. A line total
//      mistaken for a unit weight is wrong by the order quantity.
//   3. line_total needs a quantity to divide by. No qty, no capture.
//   4. Only plausible magnitudes. A per-unit weight of 0, or one large enough
//      to be a container's payload, is a parse artefact rather than a part.

const num = (v) => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// To kilograms. Anything not recognised is refused rather than assumed to be
// kg — a pound silently treated as a kilo is a 2.2x error on every allocation.
const TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, t: 1000 };

export const toKg = (value, uom) => {
  const v = num(value);
  if (v == null || v <= 0) return null;
  const key = String(uom || "kg").trim().toLowerCase();
  const f = TO_KG[key];
  return f == null ? null : Math.round(v * f * 1e6) / 1e6;
};

// Above this, a "per-unit weight" is almost certainly a line total that was
// mislabelled, or a units mix-up. A single part weighing more than a tonne is
// possible but is not something to infer from a PDF without a human.
export const MAX_PLAUSIBLE_UNIT_KG = 1000;

// Extract a per-unit kg from one extracted line, or null with the reason.
export const unitWeightFromLine = (line, docDefaults = {}) => {
  if (!line) return { kg: null, reason: "no_line" };
  // NET before gross: net is the goods, gross includes the carton. Freight is
  // charged on gross, but what a PART weighs is net — and this value is stored
  // as the part's weight, not as a shipping cost.
  const raw = num(line.weight ?? line.net_weight ?? line.weight_kg ?? line.weightKg ?? line.gross_weight);
  if (raw == null || raw <= 0) return { kg: null, reason: "no_weight_stated" };

  // A packing list often states the unit once in the header and omits it on
  // every row. Falling back to "kg" instead would silently mis-scale a
  // document printed in pounds.
  const uom = line.weight_uom ?? line.weightUom ?? docDefaults.weight_uom ?? "kg";
  const kg = toKg(raw, uom);
  if (kg == null) return { kg: null, reason: "unrecognised_unit" };

  const basis = String(line.weight_basis ?? line.weightBasis ?? "").toLowerCase();
  if (basis === "per_unit") {
    return kg <= MAX_PLAUSIBLE_UNIT_KG ? { kg, reason: null } : { kg: null, reason: "implausible_magnitude" };
  }
  if (basis === "line_total") {
    const qty = num(line.quantity ?? line.qty);
    if (qty == null || qty <= 0) return { kg: null, reason: "line_total_without_qty" };
    const per = Math.round((kg / qty) * 1e6) / 1e6;
    if (per <= 0) return { kg: null, reason: "implausible_magnitude" };
    return per <= MAX_PLAUSIBLE_UNIT_KG ? { kg: per, reason: null } : { kg: null, reason: "implausible_magnitude" };
  }
  // The extractor could not tell which the column meant, so neither can we.
  return { kg: null, reason: "ambiguous_basis" };
};

// Which parts a document can teach a weight for.
//
// Pure: the caller resolves part numbers to item ids and does the writing, so
// this stays testable without a database.
export const weightCandidates = (lines, docDefaults = {}) => {
  const take = [];
  const skipped = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const partNo = (l?.partNumber ?? l?.part_no ?? "").toString().trim();
    const { kg, reason } = unitWeightFromLine(l, docDefaults);
    if (!partNo) continue;
    if (kg == null) {
      // Only worth reporting when the document DID state something we then
      // refused — "no weight printed" is the normal case and is not a skip.
      if (reason !== "no_weight_stated" && reason !== "no_line") skipped.push({ part_no: partNo, reason });
      continue;
    }
    take.push({ part_no: partNo.toUpperCase(), weight_kg: kg });
  }
  // One document can list the same part twice. Keep the first and drop the
  // rest rather than letting the last row win by accident.
  const seen = new Set();
  const unique = take.filter((t) => (seen.has(t.part_no) ? false : (seen.add(t.part_no), true)));
  return { candidates: unique, skipped };
};

// VOLUME, by exactly the same rules.
//
// A packing list's measurement column (CBM) was extracted and then dropped —
// PACKING_LIST_TOOL had the slot, nothing read it. That is not a cosmetic gap:
// estimateContainers takes the MAX of the weight-fill and volume-fill ratios
// (freight-consolidation.js), and LCL ocean is priced on weight-or-measure,
// whichever is greater. A master with weights and no volumes still cannot size
// or price an LCL shipment — the light-and-bulky case is exactly the one where
// volume decides.
//
// Same discipline as weight: an ambiguous basis is refused, because a row
// measurement taken as a per-unit figure is wrong by the quantity.

// A single unit larger than a 40ft container's usable volume is a parse
// artefact, not a part.
export const MAX_PLAUSIBLE_UNIT_CBM = 67;

export const unitVolumeFromLine = (line) => {
  if (!line) return { cbm: null, reason: "no_line" };
  const raw = num(line.volume_cbm ?? line.volumeCbm ?? line.cbm);
  if (raw == null || raw <= 0) return { cbm: null, reason: "no_volume_stated" };

  const basis = String(line.volume_basis ?? line.volumeBasis ?? "").toLowerCase();
  const bound = (v) => (v > 0 && v <= MAX_PLAUSIBLE_UNIT_CBM ? { cbm: Math.round(v * 1e6) / 1e6, reason: null } : { cbm: null, reason: "implausible_magnitude" });

  if (basis === "per_unit") return bound(raw);
  if (basis === "line_total") {
    const qty = num(line.quantity ?? line.qty);
    if (qty == null || qty <= 0) return { cbm: null, reason: "line_total_without_qty" };
    return bound(raw / qty);
  }
  return { cbm: null, reason: "ambiguous_basis" };
};

// Parts a document can teach a per-unit volume for. Mirrors weightCandidates.
export const volumeCandidates = (lines) => {
  const take = [];
  const skipped = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const partNo = (l?.partNumber ?? l?.part_no ?? "").toString().trim();
    const { cbm, reason } = unitVolumeFromLine(l);
    if (!partNo) continue;
    if (cbm == null) {
      if (reason !== "no_volume_stated" && reason !== "no_line") skipped.push({ part_no: partNo, reason, field: "volume" });
      continue;
    }
    take.push({ part_no: partNo.toUpperCase(), volume_cbm: cbm });
  }
  const seen = new Set();
  return { candidates: take.filter((t) => (seen.has(t.part_no) ? false : (seen.add(t.part_no), true))), skipped };
};
