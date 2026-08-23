// Who was right — Anvil, the clerk, or neither.
//
// Comparing Anvil against Tally measures AGREEMENT WITH A PERSON, and a person
// is not the authority on what the customer ordered. The purchase order is.
// A two-way harness that scores Anvil against a clerk's entry rewards Anvil
// for reproducing the clerk's mistakes and marks it wrong for catching them —
// which is the opposite of the thing being bought.
//
// So every field is judged against three values: what the AUTHORITY says, what
// Anvil produced, and what Tally holds.
//
// The case that justifies all of it is BOTH_DEVIATE. On a real pair, the PO
// stated payment after 60 days and the Tally SO said 30. If Anvil had also
// said 30 — because it defaulted to the customer master's usual terms rather
// than reading the document — a two-way comparison would score that field
// 100%, agreed, perfect, while the business had quietly committed to terms
// worth 30 days of working capital that its customer never asked for. Only the
// three-way view can see it.
//
// Pure. No I/O, no knowledge of Tally, the PO, or how a value was obtained.

export const VERDICT = Object.freeze({
  AGREE: "agree",                     // authority, Anvil and Tally all match
  ANVIL_CORRECT: "anvil_correct",     // Anvil matches the authority; Tally does not
  ANVIL_WRONG: "anvil_wrong",         // Tally matches the authority; Anvil does not
  BOTH_DEVIATE: "both_deviate",       // Anvil and Tally agree with each other, not the authority
  ALL_DIFFER: "all_differ",           // three different answers
  UNDECIDABLE: "undecidable",         // the authority is silent, or could not be read
  NOT_APPLICABLE: "not_applicable",   // nothing outside Tally could know this field
});

// Only these count in a rate. UNDECIDABLE and NOT_APPLICABLE are excluded from
// BOTH numerator and denominator — a field nobody can adjudicate must not
// quietly resolve in someone's favour.
const DECIDABLE = new Set([
  VERDICT.AGREE, VERDICT.ANVIL_CORRECT, VERDICT.ANVIL_WRONG,
  VERDICT.BOTH_DEVIATE, VERDICT.ALL_DIFFER,
]);

export const isDecidable = (v) => DECIDABLE.has(v);

const isAbsent = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// The comparison vocabulary, matching eval/score.js so two parts of the system
// do not disagree about whether two values are the same.
const eqText = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const eqNumber = (a, b, tol) => {
  const av = Number(a), bv = Number(b);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
  return Math.abs(av - bv) <= Math.max(0.01, Math.abs(bv) * (tol || 0.005));
};

const comparerFor = (spec) => {
  if (typeof spec?.compare === "function") return spec.compare;
  if (spec?.compare === "number") return (a, b) => eqNumber(a, b, spec.tolerance);
  return eqText;
};

// Judge one field.
//
// `truth` is whatever the field's AUTHORITY says — the caller resolves that,
// because the authority is not always the PO. Quantity and rate are stated on
// the purchase order. Our own part number never is: the PO carries the buyer's
// code, and the mapping to ours lives in item_master, so item_master is that
// field's authority. A voucher number has no authority outside Tally at all.
// Naming the authority per field is what stops the awkward ones being fudged.
//
// spec: { key, authority: "po"|"item_master"|"none", compare, tolerance, normalise }
export const adjudicateField = ({ truth, anvil, tally }, spec = {}) => {
  const key = spec.key || null;
  const authority = spec.authority || "po";

  // Tally assigns it; nobody else could have known it. Not a pass, not a fail.
  if (authority === "none") {
    return { key, authority, verdict: VERDICT.NOT_APPLICABLE, decidable: false };
  }

  // Normalise before comparing, so "60 days after receipt" and "Net 60" are one
  // value rather than two. A field with no normaliser is compared raw — which
  // is right for a part number and wrong for prose, and is exactly why an
  // interpreted field stays undecidable until someone writes and tests one.
  const norm = typeof spec.normalise === "function" ? spec.normalise : (v) => v;
  let t, a, y;
  try {
    t = isAbsent(truth) ? truth : norm(truth);
    a = isAbsent(anvil) ? anvil : norm(anvil);
    y = isAbsent(tally) ? tally : norm(tally);
  } catch (_e) {
    // A normaliser that cannot read a value has not proved anything about it.
    return { key, authority, verdict: VERDICT.UNDECIDABLE, decidable: false, reason: "normalise_failed" };
  }

  // The authority is silent, or its value could not be read. Default to
  // undecidable rather than guessing: a harness that resolves ambiguity in
  // somebody's favour is worse than one that admits the gap, and this repo has
  // already watched a noisy exception engine get switched off.
  if (isAbsent(t)) {
    return { key, authority, verdict: VERDICT.UNDECIDABLE, decidable: false, reason: "authority_silent" };
  }

  const same = comparerFor(spec);
  const anvilMatches = !isAbsent(a) && same(a, t);
  const tallyMatches = !isAbsent(y) && same(y, t);
  const pairMatch = isAbsent(a) && isAbsent(y) ? true : (!isAbsent(a) && !isAbsent(y) && same(a, y));

  let verdict;
  if (anvilMatches && tallyMatches) verdict = VERDICT.AGREE;
  else if (anvilMatches) verdict = VERDICT.ANVIL_CORRECT;
  else if (tallyMatches) verdict = VERDICT.ANVIL_WRONG;
  else if (pairMatch) verdict = VERDICT.BOTH_DEVIATE;
  else verdict = VERDICT.ALL_DIFFER;

  return {
    key, authority, verdict,
    decidable: DECIDABLE.has(verdict),
    // The values as compared, so a disputed verdict can be re-read without
    // re-running the normaliser.
    truth: t, anvil: a, tally: y,
  };
};

// Two rates, deliberately. One number cannot carry this.
//
// Reporting only Anvil's error rate would bury the finding that sells the
// thing: on the first real pair, two fields departed from the PO and neither
// was Anvil's doing. A tenant deciding whether to trust Anvil needs to see
// both how often Anvil is wrong AND how often the current manual process
// already is.
export const scoreAdjudications = (rows) => {
  const counts = Object.fromEntries(Object.values(VERDICT).map((v) => [v, 0]));
  for (const r of rows || []) {
    if (r?.verdict && counts[r.verdict] !== undefined) counts[r.verdict]++;
  }
  const decidable = [...DECIDABLE].reduce((n, v) => n + counts[v], 0);
  const anvilWrong = counts[VERDICT.ANVIL_WRONG] + counts[VERDICT.BOTH_DEVIATE] + counts[VERDICT.ALL_DIFFER];
  const processWrong = counts[VERDICT.ANVIL_CORRECT] + counts[VERDICT.BOTH_DEVIATE] + counts[VERDICT.ALL_DIFFER];
  const rate = (n) => (decidable ? Math.round((n / decidable) * 10000) / 10000 : null);
  return {
    counts,
    decidable,
    undecidable: counts[VERDICT.UNDECIDABLE],
    not_applicable: counts[VERDICT.NOT_APPLICABLE],
    // Anvil departed from the authority — BOTH_DEVIATE and ALL_DIFFER included,
    // because in both Anvil is also not matching the authority. Agreeing with
    // the clerk is not an excuse.
    anvil_error_rate: rate(anvilWrong),
    // The manual process departed from the authority. Same reasoning.
    process_deviation_rate: rate(processWrong),
    // Null, not zero, when nothing was decidable. A rate over an empty
    // denominator reads as a perfect score.
    basis: decidable ? "decidable_fields" : "no_decidable_fields",
  };
};
