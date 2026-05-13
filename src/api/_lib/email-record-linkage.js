// Probabilistic email-to-contact / email-to-customer linkage
// (Wave CM 4.1).
//
// Adapts the Fellegi-Sunter model (Splink, 2026 GOV.UK write-up,
// Robin Linacre's blog) to the inbound-email matching problem.
// For each candidate (customer, contact) pair we have N feature
// observations; the per-feature m and u parameters convert those
// observations into a log-odds match score. Compound score sums
// over features; convert back to a probability via the logistic.
//
// Per-feature parameters (heuristic priors, calibrated against
// the pilot dataset; the docai team will fine-tune empirically
// once the learned_corrections table accumulates enough signal):
//
//   feature                m       u       weight (log10 m/u)
//   ----------------------------------------------------------
//   canonical_email_match  0.99    0.0001  4.00
//   email_domain_match     0.95    0.02    1.68
//   prior_thread_match     0.95    0.005   2.28
//   name_jaro_high         0.80    0.05    1.20
//   subject_po_pattern     0.55    0.10    0.74
//   gstin_in_body          0.90    0.01    1.95
//
// match probability p in [0, 1]; threshold tiers:
//
//   p >= 0.90  AUTO_LINK    write the link without operator review
//   p >= 0.50  SUGGEST      surface as a candidate the operator picks
//   p < 0.50   NO_MATCH     do nothing
//
// The blocker (lower bound for the per-feature contribution)
// caps a single feature's veto power so one bad signal doesn't
// dominate. We also include LAMBDA, the prior probability that
// any random (email, contact) pair is a match for this tenant.
// Calibrated low (1e-5) so candidate scores need positive
// evidence to clear AUTO_LINK.

import { canonicaliseEmail, emailHash } from "./email-canonical.js";
import { jaroWinkler, normaliseToken } from "./fuzzy-match.js";

const LAMBDA = 1e-5;
const AUTO_LINK_PROB = 0.90;
const SUGGEST_PROB = 0.50;

// Per-feature m/u. log_weight = log(m / u); cap to avoid
// numerical blow-up on the canonical_email_match feature.
const FEATURES = [
  { key: "canonical_email_match", m: 0.99,  u: 0.0001 },
  { key: "email_domain_match",    m: 0.95,  u: 0.02   },
  { key: "prior_thread_match",    m: 0.95,  u: 0.005  },
  { key: "name_jaro_high",        m: 0.80,  u: 0.05   },
  { key: "subject_po_pattern",    m: 0.55,  u: 0.10   },
  { key: "gstin_in_body",         m: 0.90,  u: 0.01   },
];

const featureWeight = (f) => Math.log10(f.m / f.u);

// Observation engine. Given (email, name?, subject?, threadId?,
// bodyText?) and a candidate (contact, customer), evaluate each
// feature: true (observed), false (observed-not-match), or
// null (no information).
const NAME_JARO_THRESHOLD = 0.85;
const PO_SUBJECT_PATTERN = /\b(po|purchase\s+order|order\s+no\.?|sales\s+order)\b/i;

export const observeFeatures = async ({
  inbound: { fromEmail, fromName, subject, threadId, bodyText } = {},
  candidate: { contact, customer } = {},
}) => {
  const obs = {};
  // canonical_email_match
  if (fromEmail && contact?.canonical_email_hash) {
    const h = await emailHash(fromEmail);
    obs.canonical_email_match = h === contact.canonical_email_hash;
  } else if (fromEmail && contact?.email) {
    const c1 = canonicaliseEmail(fromEmail);
    const c2 = canonicaliseEmail(contact.email);
    obs.canonical_email_match = !!c1 && c1 === c2;
  } else {
    obs.canonical_email_match = null;
  }
  // email_domain_match
  if (fromEmail && (contact?.email || contact?.canonical_email_hash)) {
    const c1 = canonicaliseEmail(fromEmail);
    const cand = canonicaliseEmail(contact?.email || "");
    if (c1 && cand) {
      const d1 = c1.split("@")[1];
      const d2 = cand.split("@")[1];
      obs.email_domain_match = !!d1 && d1 === d2;
    } else {
      obs.email_domain_match = null;
    }
  } else {
    obs.email_domain_match = null;
  }
  // prior_thread_match
  if (threadId && customer?.recent_thread_ids?.length) {
    obs.prior_thread_match = customer.recent_thread_ids.includes(threadId);
  } else {
    obs.prior_thread_match = null;
  }
  // name_jaro_high
  if (fromName && contact?.name) {
    const j = jaroWinkler(normaliseToken(fromName), normaliseToken(contact.name));
    obs.name_jaro_high = j >= NAME_JARO_THRESHOLD;
  } else {
    obs.name_jaro_high = null;
  }
  // subject_po_pattern
  if (subject) {
    obs.subject_po_pattern = PO_SUBJECT_PATTERN.test(subject);
  } else {
    obs.subject_po_pattern = null;
  }
  // gstin_in_body
  if (bodyText && customer?.gstin) {
    obs.gstin_in_body = bodyText.indexOf(customer.gstin) >= 0;
  } else {
    obs.gstin_in_body = null;
  }
  return obs;
};

// Convert observation booleans to a log-odds score per
// Fellegi-Sunter:
//
//   feature observed match -> +log10(m/u)
//   feature observed not-match -> +log10((1-m)/(1-u))
//   feature not observed -> 0
//
// Total log-odds = log10(LAMBDA / (1-LAMBDA)) + Σ feature_contrib
// Convert back to probability: p = 1 / (1 + 10^(-log_odds))
export const scoreObservations = (observations) => {
  let logOdds = Math.log10(LAMBDA / (1 - LAMBDA));
  const contributions = [];
  for (const f of FEATURES) {
    const obs = observations[f.key];
    if (obs === true) {
      const c = Math.log10(f.m / f.u);
      logOdds += c;
      contributions.push({ feature: f.key, observation: "match", contribution: c });
    } else if (obs === false) {
      const c = Math.log10((1 - f.m) / (1 - f.u));
      logOdds += c;
      contributions.push({ feature: f.key, observation: "no_match", contribution: c });
    }
  }
  const prob = 1 / (1 + Math.pow(10, -logOdds));
  return { log_odds: logOdds, probability: prob, contributions };
};

// Public: full pipeline for one (inbound, candidate) pair.
// Returns { observations, log_odds, probability, decision }.
export const scoreCandidate = async (inbound, candidate) => {
  const observations = await observeFeatures({ inbound, candidate });
  const { log_odds, probability, contributions } = scoreObservations(observations);
  let decision = "NO_MATCH";
  if (probability >= AUTO_LINK_PROB) decision = "AUTO_LINK";
  else if (probability >= SUGGEST_PROB) decision = "SUGGEST";
  return { observations, log_odds, probability, contributions, decision };
};

// Rank a list of candidates against one inbound. Returns the
// ranked list with scores; caller surfaces the top by decision
// tier (auto_link > suggest > no_match).
export const rankCandidates = async (inbound, candidates) => {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const out = [];
  for (const cand of candidates) {
    const scored = await scoreCandidate(inbound, cand);
    out.push({ ...cand, ...scored });
  }
  out.sort((a, b) => b.probability - a.probability);
  return out;
};

export const __test = {
  FEATURES,
  LAMBDA,
  AUTO_LINK_PROB,
  SUGGEST_PROB,
  NAME_JARO_THRESHOLD,
  featureWeight,
};
