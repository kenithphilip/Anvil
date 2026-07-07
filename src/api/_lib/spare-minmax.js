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

// Tunables.
const BULK_MIN_MULT = 1.0;   // consumables: keep ~a full replacement set...
const BULK_MAX_MULT = 1.5;   // ...up to 1.5x installed.
const EXP_MAX_PER = 0.2;     // expensive: ~1 per 5 installed...
const EXP_MAX_CAP = 4;       // ...capped, and a floor of 1.

export const computeMinMax = ({ installed_qty, item_type, description } = {}) => {
  const inst = Math.max(0, Math.floor(Number(installed_qty) || 0));
  const policy = classifyPolicy({ item_type, description });
  if (inst === 0) return { recommended_min: 0, recommended_max: 0, policy };
  if (policy === "bulk") {
    return {
      recommended_min: Math.max(1, Math.round(inst * BULK_MIN_MULT)),
      recommended_max: Math.max(1, Math.ceil(inst * BULK_MAX_MULT)),
      policy,
    };
  }
  // expensive: hold 1, up to ~2-4 scaled by installed.
  const max = Math.max(1, Math.min(EXP_MAX_CAP, Math.ceil(inst * EXP_MAX_PER)));
  return { recommended_min: 1, recommended_max: max, policy };
};
