// Customer ICP (Ideal Customer Profile) scoring — the pure engine.
//
// ICP fit is a firmographic axis distinct from ai_health_score (which is
// behavioral). A tenant defines a rubric (gate + weighted rules + tiers) over a
// GENERIC attribute map, so any company scores its own ICP with no code change
// -- the attribute keys come from the categorized customer_registration_fields
// store + core customer columns + hierarchy. Design: docs/ICP_FRAMEWORK_DESIGN.md.
//
// Pure module: no DB/network. Safe to unit-test. The compute layer
// (icp endpoint) resolves a customer's attributes and persists the result.

const s = (v) => (v == null ? "" : String(v)).trim();
const up = (v) => s(v).toUpperCase();
const exists = (v) => s(v) !== "";
const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Evaluate one rule against the attribute map. A rule:
//   { attribute_key, op, value?, weight, label? }
// op: equals | not_equals | in | not_in | exists | absent | gte | lte |
//     range | matches
export const evalRule = (attrs, rule) => {
  const attr = attrs ? attrs[rule.attribute_key] : undefined;
  const val = rule.value;
  switch (rule.op) {
    case "exists":     return exists(attr);
    case "absent":     return !exists(attr);
    case "equals":     return exists(attr) && up(attr) === up(val);
    case "not_equals": return up(attr) !== up(val);
    case "in":         return Array.isArray(val) && val.map(up).includes(up(attr)) && exists(attr);
    case "not_in":     return !(Array.isArray(val) && val.map(up).includes(up(attr)));
    case "gte":        { const n = asNum(attr); return n != null && n >= Number(val); }
    case "lte":        { const n = asNum(attr); return n != null && n <= Number(val); }
    case "range":      { const n = asNum(attr); return n != null && Array.isArray(val) && n >= Number(val[0]) && n <= Number(val[1]); }
    case "matches":    { try { return exists(attr) && new RegExp(String(val), "i").test(s(attr)); } catch { return false; } }
    default:           return false;
  }
};

const tierFor = (score, tiers) => {
  const t = Array.isArray(tiers) && tiers.length
    ? tiers
    : [{ min: 65, tier: "A" }, { min: 35, tier: "B" }, { min: 0, tier: "C" }];
  // Highest matching cutoff wins.
  const sorted = [...t].sort((a, b) => Number(b.min) - Number(a.min));
  for (const row of sorted) if (score >= Number(row.min)) return row.tier;
  return sorted.length ? sorted[sorted.length - 1].tier : "C";
};

// A neutral, editable starter rubric (an industrial-B2B default). Tenants
// replace this via icp_profiles; nothing here is hardcoded into the scorer.
export const DEFAULT_ICP_PROFILE = {
  name: "Default ICP",
  gate: [],
  rules: [
    { attribute_key: "customer_type",      op: "in",     value: ["OEM", "Tier-1"], weight: 30, label: "Target customer type" },
    { attribute_key: "gst_status",         op: "equals", value: "Active",          weight: 20, label: "GST registration Active" },
    { attribute_key: "country",            op: "equals", value: "IN",              weight: 15, label: "Domestic (India)" },
    { attribute_key: "industry_segment",   op: "exists",                            weight: 15, label: "Industry captured" },
    { attribute_key: "parent_customer_id", op: "exists",                            weight: 10, label: "Part of a corporate group" },
    { attribute_key: "gstin",              op: "exists",                            weight: 10, label: "GST-registered business" },
  ],
  tiers: [{ min: 65, tier: "A" }, { min: 35, tier: "B" }, { min: 0, tier: "C" }],
};

// Score a customer's attribute map against a profile.
// Returns { score (0-100), tier, signals: { matched[], missed[], gate_failed[] } }.
export const scoreCustomer = (attrs = {}, profile = DEFAULT_ICP_PROFILE) => {
  const p = profile && Array.isArray(profile.rules) ? profile : DEFAULT_ICP_PROFILE;

  // Hard gate: any failed qualifier disqualifies (tier "Out").
  const gateFailed = [];
  for (const g of (p.gate || [])) {
    if (!evalRule(attrs, g)) gateFailed.push(g.label || g.attribute_key);
  }
  if (gateFailed.length) {
    return { score: 0, tier: "Out", signals: { matched: [], missed: [], gate_failed: gateFailed } };
  }

  const rules = p.rules || [];
  const totalWeight = rules.reduce((sum, r) => sum + (Number(r.weight) || 0), 0) || 1;
  let earned = 0;
  const matched = [];
  const missed = [];
  for (const r of rules) {
    const w = Number(r.weight) || 0;
    if (evalRule(attrs, r)) { earned += w; matched.push(r.label || r.attribute_key); }
    else missed.push(r.label || r.attribute_key);
  }
  const score = Math.round((earned / totalWeight) * 100);
  return { score, tier: tierFor(score, p.tiers), signals: { matched, missed, gate_failed: [] } };
};

export const __test__ = { tierFor, exists };
