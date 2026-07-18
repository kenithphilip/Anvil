// Spare-matrix Recommended-sheet policy helpers (pure, testable):
//   - classifyItemType(): auto-decide Consumable vs Spare for a part, so
//     the operator doesn't hand-tag every row.
//   - computeMinMax(): reorder-policy min/max from installed_qty + type.
//
// Domain rule (servo-gun spares): copper CONSUMABLES (cap tips, shanks,
// shunts, electrodes) are held in BULK, near the installed count, because
// they wear out. Expensive SPARES / assemblies (gear case, transformer,
// TR box, gun body, yoke) are held LOW — one or two, scaled a little by
// how many are installed. Both are tunable via the constants below and
// overridable per row by the operator.

// Copper / wear consumables -> Consumable (bulk policy).
const CONSUMABLE_RX = /\b(cap\s*tip|tip\s*base|tip\s*adapter|shank|electrode|shunt|point\s*holder|holder|contact\s*tip|weld(ing)?\s*tip|dress(ing)?)\b/i;
// High-value assemblies -> Spare (low policy). Includes the parts Joel
// named explicitly (gear case, transformer) plus the other big assemblies.
const EXPENSIVE_RX = /\b(gear\s*case|transformer|tr\s*box|gun\s*body|movable\s*yoke|yoke|arm\s*ass(?:y|embly)|manifold|cylinder|servo|actuator|balancer|spatter\s*cover|bracket\s*ass(?:y|embly))\b/i;
const ASSY_RX = /\bass(?:y|embly)\b/i;

// Decide item type from the spare category name + the matrix column
// category (Consumable/Spare) + part number. Keyword hits win over the
// coarse column category; unknown assemblies and everything else default
// to Spare (the conservative, low-stock policy).
export const classifyItemType = ({ description, category, part_no } = {}) => {
  const d = String(description || "") + " " + String(part_no || "");
  if (CONSUMABLE_RX.test(d)) return "Consumable";
  if (EXPENSIVE_RX.test(d)) return "Spare";
  const cat = String(category || "").trim().toLowerCase();
  if (cat === "consumable") return "Consumable";
  if (cat === "spare") return "Spare";
  if (ASSY_RX.test(d)) return "Spare";
  return "Spare";
};

// "bulk" (near installed) vs "expensive" (low). item_type is the primary
// lever (operator sets it); the expensive keyword is a safety net so the
// parts Joel named stay low even if mis-tagged.
export const classifyPolicy = ({ item_type, description } = {}) => {
  const d = String(description || "");
  if (EXPENSIVE_RX.test(d)) return "expensive";
  const t = String(item_type || "").trim().toLowerCase();
  if (t === "consumable" || t === "wear part") return "bulk";
  if (CONSUMABLE_RX.test(d)) return "bulk";
  return "expensive"; // Spare / unknown -> low-stock policy
};

// Tunables (policy knobs).
const BULK_MIN_MULT = 1.0;   // consumables: ~a full replacement set...
const BULK_MAX_MULT = 1.5;   // ...up to 1.5x installed (before lead scaling).
const EXP_MIN_PER = 0.05;    // expensive: ~1 per 20 installed (floored at 1)...
const EXP_MAX_PER = 0.2;     // ...up to ~1 per 5 installed...
const EXP_MAX_CAP = 4;       // ...capped low regardless of lead/criticality.
// Lead time raises stock — you can't reorder fast on an 11-12 week import.
const LEAD_BASELINE_DAYS = 56;  // ~8 weeks -> leadMult = 1.0 (v1 behaviour).
const LEAD_MULT_MIN = 0.75;     // short-lead parts need less buffer...
const LEAD_MULT_MAX = 2.0;      // ...long-lead imports up to 2x.
const DEFAULT_LEAD_DAYS = 56;   // unknown lead -> baseline (so v1 numbers hold).
// Criticality (0..100 from recommend.js) adds up to +CRIT_WEIGHT safety stock.
const CRIT_WEIGHT = 0.5;
// Step 4c (gated): FMECA RPN (0..1000 = S*O*D) adds up to +FMECA_WEIGHT more,
// applied in the same spots as crit. Only passed when fmeca_minmax_enabled, so
// callers that omit `rpn` are byte-identical to before.
const FMECA_WEIGHT = 0.5;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Parse a free-text lead time ("11-12 weeks", "6 wk", "30 days", "2 months",
// bare "45") into days, taking the UPPER bound of a range. null if none.
export const parseLeadDays = (s) => {
  const str = String(s == null ? "" : s).toLowerCase();
  const nums = (str.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  const n = Math.max(...nums);
  if (/month/.test(str)) return Math.round(n * 30);
  if (/week|wk/.test(str)) return Math.round(n * 7);
  return Math.round(n); // "days" or a bare number -> days
};

// (s,S)-style reorder policy. min (reorder point) ~ demand over the
// replenishment lead time; max (order-up-to) adds a review buffer. Both
// scale with LEAD TIME (long-lead imports need more on the shelf) and,
// when available, CRITICALITY (0..100). installed_qty is the exposure /
// population; the wear class (bulk vs expensive) sets the base consumption
// ratio. With unknown lead + no criticality this reduces to the v1 numbers.
export const computeMinMax = ({ installed_qty, item_type, description, lead_time_days, criticality_score, rpn } = {}) => {
  const inst = Math.max(0, Math.floor(Number(installed_qty) || 0));
  const policy = classifyPolicy({ item_type, description });
  const leadDays = parseLeadDays(lead_time_days) || DEFAULT_LEAD_DAYS;
  const leadMult = clamp(leadDays / LEAD_BASELINE_DAYS, LEAD_MULT_MIN, LEAD_MULT_MAX);
  const critNorm = criticality_score != null ? clamp(Number(criticality_score) / 100, 0, 1) : 0;
  const critMult = 1 + CRIT_WEIGHT * critNorm;
  // FMECA RPN augment (gated by the caller): null -> rpnMult 1.0 -> unchanged.
  const rpnNorm = rpn != null ? clamp(Number(rpn) / 1000, 0, 1) : 0;
  const rpnMult = 1 + FMECA_WEIGHT * rpnNorm;
  const basis = { lead_days: leadDays, lead_mult: round2(leadMult), crit_mult: round2(critMult), rpn_mult: round2(rpnMult), policy };
  if (inst === 0) return { recommended_min: 0, recommended_max: 0, policy, basis };
  if (policy === "bulk") {
    const min = Math.max(1, Math.ceil(inst * BULK_MIN_MULT * leadMult * critMult * rpnMult));
    const max = Math.max(min, Math.ceil(inst * BULK_MAX_MULT * leadMult));
    return { recommended_min: min, recommended_max: max, policy, basis };
  }
  // expensive: stays low (capped) but a long lead / high criticality / high RPN
  // can nudge it from 1 toward the cap.
  const min = clamp(Math.ceil(inst * EXP_MIN_PER * leadMult * critMult * rpnMult), 1, EXP_MAX_CAP);
  const max = clamp(Math.ceil(inst * EXP_MAX_PER * leadMult * critMult * rpnMult), min, EXP_MAX_CAP);
  return { recommended_min: min, recommended_max: max, policy, basis };
};
