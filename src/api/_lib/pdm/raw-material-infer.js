// PDM: raw-material determination from a part / assembly drawing extraction.
//
// Given a part's material callout + overall dimensions (+ any make/buy signal),
// decide what RAW MATERIAL is needed to make it — material grade, stock FORM
// (rod / bar / plate / block / casting) and stock DIMENSIONS — OR that the part
// is bought-out and needs no raw material at all.
//
// THE MAKE/BUY GATE IS FIRST AND DECISIVE. A bought-out part (a bearing, a
// standard fastener, an OEM sub-assembly) returns recipe = null, so the demand
// engine never explodes it into raw-material demand — it stays at part-level
// procurement ("buy the part"). When make/buy is UNCERTAIN we default to BUY,
// so the raw-material forecast is never inflated by parts we don't machine.
// Manufacturing confirms/corrects the verdict downstream (human in the loop).
//
// Pure + dependency-free (fully unit-testable). It's the deterministic core;
// the drawing extraction feeds it, a review UI corrects it, and the result
// persists into composition_material_lines (material / form / density /
// gross_qty / consumption_per_unit) — which already syncs to bill_of_materials
// and drives the pipeline + committed demand explosion.

const norm = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const numPos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const round = (n, dp = 2) => { const f = 10 ** dp; return Math.round((Number(n) || 0) * f) / f; };

// ── Material-grade master (seed; governed by code review like the metric ──
// catalog). grade -> density (kg/m³) + the stock forms it's typically bought
// in. Aliases cover the nomenclature that appears on Indian mfg drawings. A
// per-tenant editable table can layer on later; this is the default set.
export const MATERIAL_GRADES = [
  { key: "CuCrZr", density: 8900, forms: ["rod", "bar", "plate"], note: "copper-chrome-zirconium, weld-gun electrode alloy",
    aliases: ["CUCRZR", "CRCU", "CUCR", "CUCR1ZR", "CRCUZR", "COPPERCHROME", "CHROMECOPPER", "C18150"] },
  { key: "EN8", density: 7850, forms: ["rod", "bar", "plate", "block"], aliases: ["EN8", "C45", "080M40", "1045"] },
  { key: "EN19", density: 7850, forms: ["rod", "bar", "block"], aliases: ["EN19", "4140", "709M40", "42CRMO4"] },
  { key: "EN24", density: 7850, forms: ["rod", "bar", "block"], aliases: ["EN24", "817M40", "4340"] },
  { key: "MS", density: 7850, forms: ["plate", "sheet", "rod", "block"], aliases: ["MS", "MILDSTEEL", "IS2062", "A36"] },
  { key: "SS304", density: 8000, forms: ["rod", "bar", "plate", "sheet"], aliases: ["SS304", "304", "AISI304", "A2"] },
  { key: "SS316", density: 8000, forms: ["rod", "bar", "plate", "sheet"], aliases: ["SS316", "316", "AISI316", "A4"] },
  { key: "AL6061", density: 2700, forms: ["plate", "rod", "bar", "block"], aliases: ["AL6061", "6061", "ALUMINIUM", "ALUMINUM", "HE30"] },
  { key: "BRASS", density: 8500, forms: ["rod", "bar"], aliases: ["BRASS", "CZ121", "C36000"] },
  { key: "CI", density: 7200, forms: ["casting"], aliases: ["CI", "CASTIRON", "FG260", "GREYCASTIRON"] },
];

// Resolve a free-text material callout to a known grade + density. Token-based
// (not substring) so "MS PLATE" -> MS but "SOMSTUFF" does not falsely match MS.
export const normalizeMaterial = (callout) => {
  const raw = String(callout == null ? "" : callout).toUpperCase();
  const compact = raw.replace(/[^A-Z0-9]/g, "");
  if (!compact) return { grade: null, density: null, forms: [], matched: false };
  const tokens = new Set(raw.split(/[^A-Z0-9]+/).map((t) => t.replace(/[^A-Z0-9]/g, "")).filter(Boolean));
  for (const g of MATERIAL_GRADES) {
    const keys = [norm(g.key), ...g.aliases];
    if (keys.some((k) => tokens.has(k) || compact === k)) {
      return { grade: g.key, density: g.density, forms: g.forms, matched: true, note: g.note || null };
    }
  }
  return { grade: null, density: null, forms: [], matched: false };
};

// Standard bought-out hardware — description patterns that mean "buy, don't make".
const STD_HARDWARE_RE = /\b(bearing|bush(?:ing)?|circlip|c-?clip|o-?ring|oil ?seal|seal|gasket|screw|bolt|hex|nut|washer|fastener|dowel|spring|coupling|connector|valve|sensor|switch|solenoid|motor|pump|cylinder|filter|hose|fitting|grommet|rivet|stud|key(?:way)?|clamp|hinge|handle|knob|caster)\b/i;

// MAKE / BUY / RAW_MATERIAL classification. This is the gate: only "make"
// parts get a raw-material recipe. Signals, highest priority first.
export const classifyMakeBuy = (input = {}) => {
  const { material, is_bought_out, std_category, item_type, description } = input;

  if (is_bought_out === true) return { procurement_type: "buy", reason: "flagged bought-out on the drawing", confidence: 0.95 };

  const stdc = String(std_category == null ? "" : std_category).toUpperCase();
  if (/BOP|BOUGHT|PURCHAS|STANDARD|OEM|PROPRIETARY|STOCK ?ITEM|CATALOG/.test(stdc)) {
    return { procurement_type: "buy", reason: "std_category=" + std_category, confidence: 0.9 };
  }

  const it = String(item_type == null ? "" : item_type).toUpperCase();
  if (it === "RAW_MATERIAL") return { procurement_type: "raw_material", reason: "item_type RAW_MATERIAL (is itself the raw material)", confidence: 1 };
  if (it === "CONSUMABLE") return { procurement_type: "buy", reason: "consumable", confidence: 0.8 };

  if (description && STD_HARDWARE_RE.test(String(description))) {
    const m = String(description).match(STD_HARDWARE_RE);
    return { procurement_type: "buy", reason: "standard hardware (" + (m && m[0]) + ")", confidence: 0.75 };
  }

  // A material callout on a detail drawing implies a machined/fabricated part.
  const mat = normalizeMaterial(material);
  const hasMaterial = mat.matched || (material != null && String(material).trim() !== "" && !/^(bought|buy|bop|std|standard|oem|na|n\/a|-)$/i.test(String(material).trim()));
  if (hasMaterial) {
    return { procurement_type: "make", reason: "material callout present (" + (mat.grade || String(material).trim()) + ")", confidence: mat.matched ? 0.7 : 0.55 };
  }

  // UNCERTAIN -> default BUY so raw-material demand is never fabricated.
  return { procurement_type: "buy", reason: "no material or make signal; defaulted to buy to avoid over-forecasting raw material", confidence: 0.4 };
};

// Geometry class from the part's overall dimensions (mm).
export const classifyGeometry = (d = {}) => {
  const dia = numPos(d.diameter ?? d.dia ?? d.od);
  const len = numPos(d.length ?? d.len);
  if (dia && len) return "rotational";
  const others = [numPos(d.length ?? d.len), numPos(d.width), numPos(d.height ?? d.thickness ?? d.thk)].filter((x) => x > 0).sort((a, b) => a - b);
  if (others.length >= 3) return others[0] * 3 <= others[2] ? "flat" : "prismatic";
  return "unknown";
};

// Stock form + dimensions + gross mass for a MAKE part. `allowanceMm` is the
// machining allowance added to each envelope dimension; `yieldPct` is the
// usable fraction (consumption = gross / yield). Returns form="casting" +
// warnings when the geometry/dimensions can't yield a machined stock size.
export const inferStock = ({ density, dimensions = {}, geometryClass, allowanceMm = 3, yieldPct = 0.85 } = {}) => {
  const a = Math.max(0, Number(allowanceMm) || 0);
  const d = dimensions || {};
  const warnings = [];
  let form = null; let stock = null; let volumeMm3 = 0;

  if (geometryClass === "rotational") {
    const dia = numPos(d.diameter ?? d.dia ?? d.od); const len = numPos(d.length ?? d.len);
    if (dia && len) { const sd = dia + 2 * a; const sl = len + a; form = dia <= 50 ? "rod" : "bar"; stock = { diameter: round(sd), length: round(sl) }; volumeMm3 = (Math.PI / 4) * sd * sd * sl; }
  } else if (geometryClass === "flat") {
    const len = numPos(d.length ?? d.len); const w = numPos(d.width); const t = numPos(d.height ?? d.thickness ?? d.thk);
    if (len && w && t) { const sl = len + a; const sw = w + a; const st = t + a; form = t <= 6 ? "sheet" : "plate"; stock = { length: round(sl), width: round(sw), thickness: round(st) }; volumeMm3 = sl * sw * st; }
  } else if (geometryClass === "prismatic") {
    const len = numPos(d.length ?? d.len); const w = numPos(d.width); const h = numPos(d.height ?? d.thickness ?? d.thk);
    if (len && w && h) { const sl = len + a; const sw = w + a; const sh = h + a; form = "block"; stock = { length: round(sl), width: round(sw), height: round(sh) }; volumeMm3 = sl * sw * sh; }
  }

  if (!form) { form = "casting"; warnings.push("geometry/dimensions insufficient for a machined stock size — treat as casting / near-net and confirm the raw form manually"); }

  const grossMassKg = (numPos(density) && volumeMm3 > 0) ? round(volumeMm3 * 1e-9 * density, 4) : null;
  if (grossMassKg == null) warnings.push("density or dimensions missing — gross mass not computed");
  const y = (Number(yieldPct) > 0 && Number(yieldPct) <= 1) ? Number(yieldPct) : 0.85;
  const consumptionKg = grossMassKg != null ? round(grossMassKg / y, 4) : null;
  return { form, stock_dims: stock, gross_mass_kg: grossMassKg, yield_pct: y, consumption_per_unit_kg: consumptionKg, warnings };
};

// The full verdict. buy / raw_material / uncertain -> recipe: null (the GATE).
// make -> a raw-material recipe (material + form + stock + mass) for review +
// persistence into composition_material_lines.
export const determineRawMaterial = (input = {}) => {
  const mb = classifyMakeBuy(input);
  if (mb.procurement_type !== "make") {
    return { procurement_type: mb.procurement_type, reason: mb.reason, confidence: mb.confidence, recipe: null, warnings: [] };
  }
  const mat = normalizeMaterial(input.material);
  const geometryClass = classifyGeometry(input.dimensions);
  const stock = inferStock({ density: mat.density, dimensions: input.dimensions, geometryClass, allowanceMm: input.allowanceMm, yieldPct: input.yieldPct });
  const warnings = [...stock.warnings];
  if (!mat.matched) warnings.push("material '" + (input.material == null ? "" : input.material) + "' not in the grade master — confirm the grade + density");
  return {
    procurement_type: "make",
    reason: mb.reason,
    confidence: mb.confidence,
    recipe: {
      material: mat.grade || (input.material != null ? String(input.material).trim() : null),
      material_matched: mat.matched,
      density: mat.density,
      geometry_class: geometryClass,
      form: stock.form,
      stock_dims: stock.stock_dims,
      gross_mass_kg: stock.gross_mass_kg,
      yield_pct: stock.yield_pct,
      consumption_per_unit_kg: stock.consumption_per_unit_kg,
      uom: "kg",
    },
    warnings,
  };
};
