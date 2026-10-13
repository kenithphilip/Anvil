// The rule comparator: the PO's terms against each quote's terms, clause by
// clause, and the severity of every difference.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 5. Rule first: a clause with a
// structured value is compared field by field, never as strings. A side with
// no readable value is "unknown", never a mismatch against unrelated text.
// The wording-only clauses (inspection, cancellation, jurisdiction, one-sided
// clauses) and the wording of warranty scope and LD belong to the LLM judge
// (plan PR 12b). Here they are only present or absent.
//
// Every comparison has an outcome (taxonomy OUTCOMES) and, when the two sides
// differ, a direction: against_us (stricter for us, the seller), for_us
// (looser), or neutral. Severity comes from the policy (section 5.3): the
// tenant's terms_policy over DEFAULT_TERMS_POLICY, key by key.
//
// Pure: no I/O. node:crypto only hashes.

import { createHash } from "node:crypto";
import {
  CLAUSE_KEYS, CLAUSE_TAXONOMY, DEFAULT_TERMS_POLICY, SEVERITY_LEVELS, valueFitsShape,
} from "./taxonomy.js";
import { NORMALIZERS, normalizeClause } from "./normalize.js";

// ── policy ──────────────────────────────────────────────────────────────────

export const isSeverity = (v) => SEVERITY_LEVELS.includes(v);
export const severityRank = (v) => SEVERITY_LEVELS.indexOf(v);

// The one action a tenant policy may name in accept_requires. It can only
// tighten the default (section 5.3): a clause that names it needs a manager
// to accept even an info or warn flag. Any other value is ignored, so a
// policy can never loosen who may accept a high or critical flag.
export const ACCEPT_HIGH_ACTION = "order.terms_accept_high";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// The policy the check applies: the tenant's terms_policy over the default,
// key by key. A severity override must be a known level, or null to turn an
// outcome off for that clause. Unknown clause keys are ignored: the
// comparators are code, so a policy can switch a clause off or re-rate it,
// not invent one.
export const effectivePolicy = (tenantPolicy) => {
  const base = DEFAULT_TERMS_POLICY;
  const t = isPlainObject(tenantPolicy) ? tenantPolicy : {};
  const out = {
    version: Number.isInteger(t.version) ? t.version : base.version,
    decide_at_or_above: isSeverity(t.decide_at_or_above) ? t.decide_at_or_above : base.decide_at_or_above,
    not_read: isSeverity(t.not_read) ? t.not_read : base.not_read,
    clauses: {},
  };
  const tc = isPlainObject(t.clauses) ? t.clauses : {};
  for (const key of CLAUSE_KEYS) {
    const d = base.clauses[key];
    const o = isPlainObject(tc[key]) ? tc[key] : {};
    const severity = { ...d.severity };
    if (d.severity.po_only_by_subtype) severity.po_only_by_subtype = { ...d.severity.po_only_by_subtype };
    for (const [k, v] of Object.entries(isPlainObject(o.severity) ? o.severity : {})) {
      if (k === "po_only_by_subtype") {
        if (!isPlainObject(v)) continue;
        severity.po_only_by_subtype = { ...(severity.po_only_by_subtype || {}) };
        for (const [sub, lv] of Object.entries(v)) if (isSeverity(lv)) severity.po_only_by_subtype[sub] = lv;
      } else if (k in severity && (v === null || isSeverity(v))) {
        severity[k] = v;
      }
    }
    out.clauses[key] = {
      enabled: o.enabled === false ? false : d.enabled !== false,
      severity,
      accept_requires: o.accept_requires === ACCEPT_HIGH_ACTION ? ACCEPT_HIGH_ACTION : null,
    };
  }
  return out;
};

// The severity for one outcome of one clause, or null when the policy says
// the outcome does not apply (no flag). refine carries the refinements the
// default policy names: place_only (incoterm), uncapped (LD), subtype
// (one-sided clauses) and po_relief (the PO's clause gives us something, such
// as "LD not applicable", while the quote is silent).
export const severityFor = (policy, clause, outcome, direction, refine = {}) => {
  const c = policy.clauses[clause];
  if (!c || !c.enabled) return null;
  const s = c.severity;
  const pick = (v) => (isSeverity(v) ? v : null);
  switch (outcome) {
    case "deviates":
      if (direction === "against_us") {
        if (refine.place_only && s.deviates_against_place_only !== undefined) return pick(s.deviates_against_place_only);
        if (refine.uncapped && s.deviates_against_uncapped !== undefined) return pick(s.deviates_against_uncapped);
        return pick(s.deviates_against);
      }
      return pick(s.deviates_for);
    case "po_only":
      if (refine.po_relief) return pick(s.deviates_for);
      if (refine.uncapped && s.po_only_uncapped !== undefined) return pick(s.po_only_uncapped);
      if (refine.subtype && s.po_only_by_subtype && s.po_only_by_subtype[refine.subtype] !== undefined) {
        return pick(s.po_only_by_subtype[refine.subtype]);
      }
      return pick(s.po_only);
    case "quote_only": return pick(s.quote_only);
    case "unknown": return pick(s.unknown);
    default: return null;
  }
};

// True when a flag at this severity needs a recorded decision.
export const needsDecision = (policy, severity) =>
  isSeverity(severity) && severityRank(severity) >= severityRank(policy.decide_at_or_above);

// ── hashing ─────────────────────────────────────────────────────────────────

// JSON with sorted keys. jsonb stores object keys in its own order, so a
// plain JSON.stringify of a value read back would not equal the one written.
export const stableStringify = (v) => {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Wording normalized for hashing: case, whitespace, curly quotes and dashes
// do not make two texts different.
export const normalizeWording = (s) => String(s == null ? "" : s)
  .toLowerCase()
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[“”„‟]/g, '"')
  .replace(/[‐-―−]/g, "-")
  .replace(/­/g, "")
  .replace(/\s+/g, " ")
  .trim();

const sideKey = (rec) => (rec ? (rec.text ? normalizeWording(rec.text) : stableStringify(rec.value ?? null)) : "");

// The hash that decides whether a decision carries forward to the next
// check (section 5.4): the clause key, the PO wording, the quote and its
// wording. Not the outcome or the severity: a re-rated policy keeps the
// hash, and the decision rule then judges the new severity.
export const flagTextHash = (clause, po, quote) => sha256(stableStringify([
  clause || "not_read", sideKey(po), quote ? quote.quote_id || null : null, sideKey(quote),
]));

// ── values ──────────────────────────────────────────────────────────────────

// The structured value of a clause record. The normalizer reads the wording
// where one exists (section 4.3: the LLM's value is only a hint, and the
// normalizer wins). A record with no wording (a structured column, such as a
// quote's validity_days) keeps its value when the value fits the shape.
export const valueOf = (clause, rec) => {
  if (!rec) return null;
  const fits = rec.value != null && valueFitsShape(clause, rec.value);
  if (clause === "validity" && fits && rec.value.expires_at) return rec.value;
  if (rec.text && NORMALIZERS[clause]) {
    const v = normalizeClause(clause, rec.text);
    if (v) return v;
  }
  return fits ? rec.value : null;
};

// ── per-clause rules ────────────────────────────────────────────────────────
//
// Each rule returns { compared, diffs, refine }. compared counts the fields
// both sides state. Each diff is { field, po, quote, direction }. No compared
// field means the two sides have nothing in common: unknown.

const AGAINST = "against_us";
const FOR = "for_us";
const NEUTRAL = "neutral";

// a > b means the PO's side puts more on us than the quote's side.
const byRank = (a, b) => (a > b ? AGAINST : a < b ? FOR : NEUTRAL);

const ruleOut = () => ({ compared: 0, diffs: [], refine: {} });

// The seller's cost and risk under each rule, lowest first. Codes on one rung
// differ in transport mode, not in what we carry. FOR and FH are the Indian
// "free on road" and "free house" terms, delivered to the buyer.
const INCOTERM_BURDEN = {
  EXW: 0, FCA: 1, FAS: 2, FOB: 3, CFR: 4, CPT: 4, CIF: 5, CIP: 5,
  DAP: 6, DAF: 6, DES: 6, DDU: 6, FOR: 6, FH: 6, DAT: 7, DPU: 7, DEQ: 7, DDP: 8,
};
const normPlace = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");

const incotermRule = (po, q) => {
  const r = ruleOut();
  if (!po.code || !q.code) return r;
  r.compared += 1;
  if (po.code !== q.code) {
    const a = INCOTERM_BURDEN[po.code];
    const b = INCOTERM_BURDEN[q.code];
    r.diffs.push({ field: "code", po: po.code, quote: q.code, direction: a == null || b == null ? NEUTRAL : byRank(a, b) });
    return r;
  }
  if (po.place && q.place) {
    r.compared += 1;
    if (normPlace(po.place) !== normPlace(q.place)) {
      // Same rule, another named place: who pays for that leg moved. The
      // default policy rates this on its own key (warn, not high).
      r.diffs.push({ field: "place", po: po.place, quote: q.place, direction: AGAINST });
      r.refine.place_only = true;
    }
  }
  return r;
};

// The clock a credit period runs from, earliest first. A later clock is a
// longer wait for our money.
const CLOCK_RANK = { invoice: 0, dispatch: 1, bl: 2, delivery: 3, grn: 4 };

const paymentRule = (po, q) => {
  const r = ruleOut();
  if (po.days != null && q.days != null) {
    r.compared += 1;
    if (po.days !== q.days) r.diffs.push({ field: "days", po: po.days, quote: q.days, direction: byRank(po.days, q.days) });
  }
  if (po.basis != null && q.basis != null) {
    r.compared += 1;
    if (po.basis !== q.basis) {
      const a = CLOCK_RANK[po.basis];
      const b = CLOCK_RANK[q.basis];
      r.diffs.push({ field: "basis", po: po.basis, quote: q.basis, direction: a == null || b == null ? NEUTRAL : byRank(a, b) });
    }
  }
  if (po.advance_pct != null && q.advance_pct != null) {
    r.compared += 1;
    // Less paid up front is more of our money at risk.
    if (po.advance_pct !== q.advance_pct) {
      r.diffs.push({ field: "advance_pct", po: po.advance_pct, quote: q.advance_pct, direction: byRank(q.advance_pct, po.advance_pct) });
    }
  }
  if (po.instrument != null && q.instrument != null) {
    r.compared += 1;
    if (po.instrument !== q.instrument) {
      // A letter of credit secures the payment. Losing it is against us,
      // gaining it is for us; any other change of instrument is neutral.
      const direction = q.instrument === "lc" ? AGAINST : po.instrument === "lc" ? FOR : NEUTRAL;
      r.diffs.push({ field: "instrument", po: po.instrument, quote: q.instrument, direction });
    }
  }
  return r;
};

// When the lead time starts. The order comes first; an advance or a drawing
// approval comes after it, so a clock that starts at the order is sooner.
const FROM_RANK = { order: 0, advance: 1, drawing_approval: 1 };
const span = (v) => (v.max_days != null ? v.max_days : v.min_days);
const addDays = (iso, days) => {
  const t = Date.parse(String(iso || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t) || days == null) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
};

const leadTimeRule = (po, q, ctx) => {
  const r = ruleOut();
  const ps = span(po);
  const qs = span(q);
  if (ps != null && qs != null) {
    r.compared += 1;
    // Fewer days for us to deliver in is against us.
    if (ps !== qs) r.diffs.push({ field: "max_days", po: ps, quote: qs, direction: byRank(qs, ps) });
  }
  if (po.from != null && q.from != null) {
    r.compared += 1;
    if (po.from !== q.from) {
      const a = FROM_RANK[po.from];
      const b = FROM_RANK[q.from];
      r.diffs.push({ field: "from", po: po.from, quote: q.from, direction: a == null || b == null ? NEUTRAL : byRank(b, a) });
    }
  }
  // A dated delivery against a period: the period runs from the PO date.
  const poDue = po.fixed_date || (ps != null && !po.fixed_date && q.fixed_date ? addDays(ctx.poDate, ps) : null);
  const qDue = q.fixed_date || (qs != null && po.fixed_date ? addDays(ctx.poDate, qs) : null);
  if ((po.fixed_date || q.fixed_date) && poDue && qDue) {
    r.compared += 1;
    if (poDue !== qDue) r.diffs.push({ field: "fixed_date", po: poDue, quote: qDue, direction: poDue < qDue ? AGAINST : FOR });
  }
  return r;
};

// Who carries the goods to the buyer under each price basis, lowest first.
const PRICE_BURDEN = { ex_works: 0, for_dispatch: 1, for_destination: 2, door_delivery: 3 };

const priceBasisRule = (po, q) => {
  const r = ruleOut();
  if (!po.basis || !q.basis) return r;
  r.compared += 1;
  if (po.basis !== q.basis) {
    r.diffs.push({ field: "basis", po: po.basis, quote: q.basis, direction: byRank(PRICE_BURDEN[po.basis], PRICE_BURDEN[q.basis]) });
    return r;
  }
  if (po.place && q.place) {
    r.compared += 1;
    if (normPlace(po.place) !== normPlace(q.place)) {
      // Delivered to another place is our freight. Ex works at another place
      // says nothing about who pays.
      const delivered = po.basis === "for_destination" || po.basis === "door_delivery";
      r.diffs.push({ field: "place", po: po.place, quote: q.place, direction: delivered ? AGAINST : NEUTRAL });
    }
  }
  return r;
};

// 1 when the cost is ours (included in the price, or the seller's), 0 when
// the buyer pays it (extra, the buyer's account, or a percentage charged).
const costBurden = (v) => (v === "included" || v === "seller" ? 1 : 0);
const showCost = (v) => (isPlainObject(v) ? v.pct + "%" : v);

const freightRule = (po, q) => {
  const r = ruleOut();
  for (const item of ["freight", "insurance", "packing"]) {
    const a = po[item];
    const b = q[item];
    if (a == null || b == null) continue;
    r.compared += 1;
    const ba = costBurden(a);
    const bb = costBurden(b);
    if (ba !== bb) {
      r.diffs.push({ field: item, po: showCost(a), quote: showCost(b), direction: byRank(ba, bb) });
    } else if (isPlainObject(a) && isPlainObject(b) && a.pct !== b.pct) {
      // Both charged at a rate: a lower rate recovers less.
      r.diffs.push({ field: item, po: showCost(a), quote: showCost(b), direction: byRank(b.pct, a.pct) });
    }
  }
  return r;
};

const taxesRule = (po, q) => {
  const r = ruleOut();
  if (po.gst && q.gst) {
    r.compared += 1;
    // Inclusive of tax means the tax comes out of our price.
    if (po.gst !== q.gst) r.diffs.push({ field: "gst", po: po.gst, quote: q.gst, direction: po.gst === "inclusive" ? AGAINST : FOR });
  }
  if (po.rate_pct != null && q.rate_pct != null) {
    r.compared += 1;
    if (po.rate_pct !== q.rate_pct) r.diffs.push({ field: "rate_pct", po: po.rate_pct, quote: q.rate_pct, direction: NEUTRAL });
  }
  return r;
};

// When the warranty clock starts, earliest first. A later start is a longer
// warranty for us to carry.
const WARRANTY_FROM_RANK = { dispatch: 0, delivery: 1, installation: 2, commissioning: 3 };

const warrantyRule = (po, q) => {
  const r = ruleOut();
  if (po.months != null && q.months != null) {
    r.compared += 1;
    if (po.months !== q.months) r.diffs.push({ field: "months", po: po.months, quote: q.months, direction: byRank(po.months, q.months) });
  }
  if (po.from != null && q.from != null) {
    r.compared += 1;
    if (po.from !== q.from) {
      r.diffs.push({ field: "from", po: po.from, quote: q.from, direction: byRank(WARRANTY_FROM_RANK[po.from], WARRANTY_FROM_RANK[q.from]) });
    }
  }
  return r;
};

const weekly = (v) => (v.rate_pct == null ? null : v.per === "day" ? v.rate_pct * 7 : v.rate_pct);
// An LD the PO imposes with no cap.
const uncapped = (v) => !!v && !v.excluded && v.rate_pct != null && v.cap_pct == null;

const ldRule = (po, q) => {
  const r = ruleOut();
  if (po.excluded != null && q.excluded != null) {
    r.compared += 1;
    if (po.excluded !== q.excluded) {
      r.diffs.push({ field: "excluded", po: po.excluded, quote: q.excluded, direction: q.excluded ? AGAINST : FOR });
      // The quote excluded LD and the PO imposes it (section 5.2: critical).
      if (q.excluded) r.refine.uncapped = true;
      return r;
    }
    if (po.excluded) return r;
  }
  const pw = weekly(po);
  const qw = weekly(q);
  if (pw != null && qw != null) {
    r.compared += 1;
    if (pw !== qw) r.diffs.push({ field: "rate_pct", po: po.rate_pct + (po.per ? "% per " + po.per : "%"), quote: q.rate_pct + (q.per ? "% per " + q.per : "%"), direction: byRank(pw, qw) });
  }
  if (po.rate_pct != null && q.rate_pct != null) {
    r.compared += 1;
    if (po.cap_pct == null && q.cap_pct != null) {
      r.diffs.push({ field: "cap_pct", po: null, quote: q.cap_pct, direction: AGAINST });
    } else if (po.cap_pct != null && q.cap_pct == null) {
      r.diffs.push({ field: "cap_pct", po: po.cap_pct, quote: null, direction: FOR });
    } else if (po.cap_pct != null && q.cap_pct != null && po.cap_pct !== q.cap_pct) {
      r.diffs.push({ field: "cap_pct", po: po.cap_pct, quote: q.cap_pct, direction: byRank(po.cap_pct, q.cap_pct) });
    }
  }
  if (uncapped(po)) r.refine.uncapped = true;
  return r;
};

const RULES = {
  incoterm: incotermRule,
  payment_terms: paymentRule,
  delivery_lead_time: leadTimeRule,
  price_basis: priceBasisRule,
  freight_insurance: freightRule,
  taxes: taxesRule,
  warranty: warrantyRule,
  ld_penalty: ldRule,
};

// Any field against us makes the clause against us; the worst case decides
// the severity. Otherwise any field for us; otherwise neutral.
const overallDirection = (diffs) => {
  if (diffs.some((d) => d.direction === AGAINST)) return AGAINST;
  if (diffs.some((d) => d.direction === FOR)) return FOR;
  return NEUTRAL;
};

// ── rationale ───────────────────────────────────────────────────────────────

const FIELD_LABEL = {
  incoterm: { code: "rule", place: "named place" },
  payment_terms: { days: "credit days", basis: "credit runs from", advance_pct: "advance %", instrument: "instrument" },
  delivery_lead_time: { max_days: "lead time in days", from: "lead time starts at", fixed_date: "delivery due" },
  price_basis: { basis: "price basis", place: "place" },
  freight_insurance: { freight: "freight", insurance: "insurance", packing: "packing" },
  taxes: { gst: "GST", rate_pct: "GST rate %" },
  warranty: { months: "warranty months", from: "warranty starts at" },
  ld_penalty: { rate_pct: "LD rate", cap_pct: "LD cap %", excluded: "LD excluded" },
};
const DIRECTION_WORDS = { against_us: "against us", for_us: "for us", neutral: "neutral" };
const show = (v) => (v == null ? "not stated" : v === true ? "yes" : v === false ? "no" : String(v).replace(/_/g, " "));

export const describeDiffs = (clause, diffs) => diffs.map((d) => {
  const label = (FIELD_LABEL[clause] && FIELD_LABEL[clause][d.field]) || d.field;
  return label + ": PO " + show(d.po) + ", quote " + show(d.quote) + " (" + DIRECTION_WORDS[d.direction] + ")";
}).join("; ") + ".";

// ── one clause ──────────────────────────────────────────────────────────────

// Compare one clause, PO record against quote record (TermClause records,
// either may be null). Returns null when neither side states it, else
// { outcome, direction, refine, diffs, reason }.
export const compareClause = (clause, po, quote, ctx = {}) => {
  if (!po && !quote) return null;
  const def = CLAUSE_TAXONOMY[clause];
  if (!def) return null;
  if (po && !quote) {
    const pv = valueOf(clause, po);
    const refine = {};
    if (clause === "ld_penalty" && pv && pv.excluded) refine.po_relief = true;
    if (clause === "ld_penalty" && uncapped(pv)) refine.uncapped = true;
    if (clause === "one_sided" && po.value && po.value.subtype) refine.subtype = po.value.subtype;
    return { outcome: "po_only", direction: refine.po_relief ? FOR : null, refine, diffs: [], reason: "po_only" };
  }
  if (!po && quote) return { outcome: "quote_only", direction: null, refine: {}, diffs: [], reason: "quote_only" };
  if (!def.rule_fields.length || !RULES[clause]) {
    return { outcome: "unknown", direction: null, refine: {}, diffs: [], reason: "wording" };
  }
  const pv = valueOf(clause, po);
  const qv = valueOf(clause, quote);
  if (!pv || !qv) return { outcome: "unknown", direction: null, refine: {}, diffs: [], reason: !pv ? "po_unparsed" : "quote_unparsed" };
  const r = RULES[clause](pv, qv, ctx);
  if (!r.compared) return { outcome: "unknown", direction: null, refine: {}, diffs: [], reason: "nothing_in_common" };
  if (!r.diffs.length) return { outcome: "match", direction: null, refine: {}, diffs: [], reason: "match" };
  return { outcome: "deviates", direction: overallDirection(r.diffs), refine: r.refine, diffs: r.diffs, reason: "deviates" };
};

// Validity is the quote's, read against the PO date: a PO dated after the
// quote expired is the deviation (section 5.2). The PO states no validity of
// its own that matters here, so there is no po_only.
export const compareValidity = (quote, poDate) => {
  if (!quote) return null;
  const qv = valueOf("validity", quote);
  if (!qv) return { outcome: "unknown", direction: null, refine: {}, diffs: [], reason: "quote_unparsed" };
  const po = poDate ? String(poDate).slice(0, 10) : null;
  if (!qv.expires_at || !po) return { outcome: "unknown", direction: null, refine: {}, diffs: [], reason: !po ? "no_po_date" : "no_expiry" };
  if (po > qv.expires_at) {
    return {
      outcome: "deviates", direction: AGAINST, refine: {}, reason: "deviates",
      diffs: [{ field: "expires_at", po, quote: qv.expires_at, direction: AGAINST }],
    };
  }
  return { outcome: "match", direction: null, refine: {}, diffs: [], reason: "match" };
};

const quoteName = (q) => (q && q.quote_number ? "Quote " + q.quote_number : "The quote");

const rationaleOf = (clause, res, quoteMeta) => {
  const label = CLAUSE_TAXONOMY[clause] ? CLAUSE_TAXONOMY[clause].label : clause;
  switch (res.reason) {
    case "po_only":
      if (res.refine.po_relief) return label + ": the PO states it in our favour. " + (quoteMeta ? quoteName(quoteMeta) + " is silent." : "No quote is linked to this order.");
      return label + ": the PO states it. " + (quoteMeta ? quoteName(quoteMeta) + " is silent." : "No quote is linked to this order.");
    case "quote_only": return label + ": " + quoteName(quoteMeta) + " states it. The PO is silent.";
    case "wording": return label + ": both sides state it. Anvil does not compare this wording yet, so read both.";
    case "po_unparsed": return label + ": the PO wording could not be read into a value.";
    case "quote_unparsed": return label + ": the wording of " + quoteName(quoteMeta).replace(/^The /, "the ") + " could not be read into a value.";
    case "nothing_in_common": return label + ": the two sides state different parts of it, so nothing could be compared.";
    case "no_po_date": return label + ": the order has no PO date, so the quote's validity could not be checked.";
    case "no_expiry": return label + ": the quote states no expiry date, so its validity could not be checked.";
    case "deviates": return label + ": " + describeDiffs(clause, res.diffs);
    default: return label + ".";
  }
};

// ── the whole order ─────────────────────────────────────────────────────────

const RULE_CLAUSES = new Set(CLAUSE_KEYS.filter((k) => CLAUSE_TAXONOMY[k].rule_fields.length));

// The PO records of one clause. A rule clause is read once: the first record
// whose wording yields a value, else the first record. A wording clause (a
// one-sided clause, cancellation, ...) is compared per record, because a PO
// can carry several.
const poRecordsOf = (clauses, key) => {
  const recs = clauses.filter((c) => c && c.clause === key);
  if (!recs.length) return [];
  if (!RULE_CLAUSES.has(key)) return recs;
  return [recs.find((c) => valueOf(key, c)) || recs[0]];
};
const quoteRecordOf = (clauses, key) => {
  const recs = (clauses || []).filter((c) => c && c.clause === key);
  return recs.find((c) => valueOf(key, c)) || recs[0] || null;
};

// The quote side of a flag: the quote's record, or, when the quote is silent,
// a record with no wording that still names the quote.
const quoteSide = (key, rec, q) => ({
  ...(rec || { clause: key, text: null, value: null }),
  side: "quote", quote_id: q.quote_id, quote_number: q.quote_number || null, primary: !!q.primary,
});

// Compare the PO's terms against every baseline quote and return the flag
// rows to write (without tenant, order or check ids).
//
// input:
//   poStatus    read | partial | not_read (order_term_checks.po_terms_status)
//   poClauses   the PO side, TermClause records
//   quotes      [{ quote_id, quote_number, primary, clauses }], primary first
//   baseline    customer-master records, shown beside the flag, never compared
//   policy      effectivePolicy(...)
//   poDate      the PO date (YYYY-MM-DD), for validity and dated deliveries
//   notReadReason  shown on the not_read row
//
// not_read gives exactly one row: the order-level "PO terms not read". It is
// never an empty list, which would read as "no deviations". quote_only is
// raised only when the PO's terms were read in full: with a partial read, a
// clause the PO seems silent on may sit on a page that was not read.
export const compareTerms = (input) => {
  const {
    poStatus, poClauses = [], quotes = [], baseline = [], policy, poDate = null, notReadReason = null,
  } = input;
  if (poStatus === "not_read") {
    return [{
      clause: null, outcome: "not_read", direction: null, severity: policy.not_read, method: "rule",
      po: null, quote: null, baseline: null,
      rationale: "PO terms not read" + (notReadReason ? ": " + notReadReason : "") + ". This is not \"no deviations\".",
      text_hash: flagTextHash(null, null, null),
    }];
  }
  const flags = [];
  const baselineOf = (key) => baseline.find((b) => b && b.clause === key) || null;
  const push = (key, res, poRec, qMeta, qRec) => {
    if (!res || res.outcome === "match") return;
    const severity = severityFor(policy, key, res.outcome, res.direction, res.refine);
    if (!severity) return;
    const quote = qMeta ? quoteSide(key, qRec, qMeta) : null;
    flags.push({
      clause: key, outcome: res.outcome, direction: res.direction, severity, method: "rule",
      po: poRec || null, quote,
      baseline: baselineOf(key),
      rationale: rationaleOf(key, res, qMeta),
      text_hash: flagTextHash(key, poRec, quote),
    });
  };

  for (const key of CLAUSE_KEYS) {
    const pc = policy.clauses[key];
    if (!pc || !pc.enabled) continue;
    if (key === "validity") {
      for (const q of quotes) {
        const qRec = quoteRecordOf(q.clauses, key);
        if (!qRec) continue;
        push(key, compareValidity(qRec, poDate), null, q, qRec);
      }
      continue;
    }
    const poRecs = poRecordsOf(poClauses, key);
    if (!poRecs.length) {
      if (poStatus !== "read") continue;
      for (const q of quotes) {
        const qRec = quoteRecordOf(q.clauses, key);
        if (qRec) push(key, compareClause(key, null, qRec), null, q, qRec);
      }
      continue;
    }
    for (const poRec of poRecs) {
      if (!quotes.length) {
        push(key, compareClause(key, poRec, null), poRec, null, null);
        continue;
      }
      for (const q of quotes) {
        const qRec = quoteRecordOf(q.clauses, key);
        push(key, compareClause(key, poRec, qRec, { poDate }), poRec, q, qRec);
      }
    }
  }
  return flags;
};

// The order flags are shown in: severity (critical first), then the primary
// quote, then the taxonomy's clause order.
export const sortFlags = (flags) => [...flags].sort((a, b) => {
  const s = severityRank(b.severity) - severityRank(a.severity);
  if (s) return s;
  const pa = a.quote && a.quote.primary ? 0 : 1;
  const pb = b.quote && b.quote.primary ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const ca = a.clause ? CLAUSE_KEYS.indexOf(a.clause) : -1;
  const cb = b.clause ? CLAUSE_KEYS.indexOf(b.clause) : -1;
  return ca - cb;
});

// What a check concluded, as one hash: the PO read, the quotes, the policy
// and every flag. A re-run whose fingerprint equals the current check's
// writes nothing (the check is idempotent). Built from stored fields only,
// so a row read back from the database hashes the same as the row written.
export const checkFingerprint = (check, flags) => sha256(stableStringify({
  status: check.po_terms_status || null,
  source: check.po_text_source || null,
  policy: check.policy_version ?? null,
  prompt: check.prompt_version || null,
  quotes: [...(check.quote_ids || [])].map(String).sort(),
  clauses: (check.po_clauses || []).map((c) => stableStringify([c.clause, c.provenance, sideKey(c), c.page ?? null])).sort(),
  flags: (flags || []).map((f) => stableStringify([
    f.clause ?? null, f.outcome, f.direction ?? null, f.severity, f.method || "rule", f.text_hash || null,
    f.rationale || null, f.quote ? f.quote.quote_id || null : null,
  ])).sort(),
}));
