// Customer dedupe sweep (Wave CM 4.2).
//
// Runs as a cron job (weekly default). Steps:
//
//   1. Pull every golden customer (is_golden=true,
//      merge_blocked=false) for the tenant.
//   2. Compute identity_hash if missing (using the same SHA-256
//      over name + gstin + country recipe the SQL trigger would
//      compute).
//   3. Group by (name first 3 chars, gstin first 2 chars).
//      Blocking keys keep the pairwise comparison from being
//      O(n^2) over the whole table.
//   4. For each within-block pair, compute Fellegi-Sunter
//      compound match probability over name + GSTIN + email
//      domain + external IDs + recent_thread overlap.
//   5. Pairs with probability >= 0.50 land in
//      customer_merge_candidates as 'open'.
//   6. Operator reviews and approves / rejects from the unified
//      workspace (CM 5.1).
//
// The sweep is idempotent: re-running the same week with the
// same data lands no new rows (the (tenant_id, customer_a_id,
// customer_b_id, status=open) unique index dedupes).
//
// Pure-ish: I/O for the DB queries, but the scoring is pure
// per-pair. No LLM, no external API.

import { createHash } from "node:crypto";
import { canonicaliseEmail } from "./email-canonical.js";
import { jaroWinkler, normaliseToken } from "./fuzzy-match.js";

const FEATURES = [
  { key: "name_jaro_high",   m: 0.90, u: 0.05  },     // jw >= 0.85
  { key: "gstin_match",      m: 0.97, u: 0.001 },
  { key: "country_match",    m: 0.95, u: 0.30  },
  { key: "domain_match",     m: 0.85, u: 0.05  },     // any contact emails share domain
  { key: "external_id_match",m: 0.99, u: 0.0001 },    // shared SAP / NetSuite ID
];

const LAMBDA = 1e-4;             // tenant-scale prior; calibrated to suppress noise
const SUGGEST_PROB = 0.50;
const NAME_JARO_THRESHOLD = 0.85;
const MAX_BLOCK_SIZE = 200;      // skip giant blocks (data quality issue)

const identityHash = (customer) => {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const name = norm(customer.display_name || customer.customer_name);
  const gstin = norm(customer.gstin);
  const country = norm(customer.country);
  const src = name + "|" + gstin + "|" + country;
  return createHash("sha256").update(src).digest("hex");
};

const blockingKey = (customer) => {
  const name = String(customer.display_name || customer.customer_name || "").trim().toLowerCase();
  const gstin = String(customer.gstin || "").trim();
  const nHead = name.replace(/[^a-z0-9]/g, "").slice(0, 3);
  const gHead = gstin.slice(0, 2);
  return nHead + "|" + gHead;
};

const observeFeatures = (a, b) => {
  const obs = {};
  // name_jaro_high
  const an = normaliseToken(a.display_name || a.customer_name || "");
  const bn = normaliseToken(b.display_name || b.customer_name || "");
  if (an && bn) {
    obs.name_jaro_high = jaroWinkler(an, bn) >= NAME_JARO_THRESHOLD;
  } else {
    obs.name_jaro_high = null;
  }
  // gstin_match
  if (a.gstin && b.gstin) {
    obs.gstin_match = String(a.gstin).trim() === String(b.gstin).trim();
  } else {
    obs.gstin_match = null;
  }
  // country_match
  if (a.country && b.country) {
    obs.country_match = String(a.country).trim() === String(b.country).trim();
  } else {
    obs.country_match = null;
  }
  // domain_match
  const ad = (a.contact_emails || []).map(canonicaliseEmail).map((e) => e ? e.split("@")[1] : null).filter(Boolean);
  const bd = (b.contact_emails || []).map(canonicaliseEmail).map((e) => e ? e.split("@")[1] : null).filter(Boolean);
  if (ad.length && bd.length) {
    obs.domain_match = ad.some((x) => bd.includes(x));
  } else {
    obs.domain_match = null;
  }
  // external_id_match
  const aExt = (a.external_ids || []).map((x) => x.system_code + "|" + x.external_id);
  const bExt = (b.external_ids || []).map((x) => x.system_code + "|" + x.external_id);
  if (aExt.length && bExt.length) {
    obs.external_id_match = aExt.some((x) => bExt.includes(x));
  } else {
    obs.external_id_match = null;
  }
  return obs;
};

const scoreObservations = (observations) => {
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
  return {
    log_odds: logOdds,
    probability: 1 / (1 + Math.pow(10, -logOdds)),
    contributions,
  };
};

export const scorePair = (a, b) => {
  const observations = observeFeatures(a, b);
  const { log_odds, probability, contributions } = scoreObservations(observations);
  return { observations, log_odds, probability, contributions };
};

// Group a flat customer list by blocking key. Returns
// Map<blockKey, Customer[]>. Single-customer blocks are
// dropped (no pairs to compare).
export const groupByBlock = (customers) => {
  const blocks = new Map();
  for (const c of customers) {
    const key = blockingKey(c);
    if (!key || key === "|") continue;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(c);
  }
  for (const [k, v] of blocks) {
    if (v.length < 2) blocks.delete(k);
  }
  return blocks;
};

// All pairs within a block, with canonical (a < b) order.
const blockPairs = (customers) => {
  const out = [];
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const a = customers[i];
      const b = customers[j];
      if (a.id < b.id) out.push([a, b]);
      else out.push([b, a]);
    }
  }
  return out;
};

// Decide which row should be the suggested winner. Heuristic
// priorities (operator can override):
//   1. is_golden=true beats false.
//   2. Higher contact_count.
//   3. More recent last_active_at.
//   4. Lower id as tiebreak (stable).
const chooseWinner = (a, b) => {
  if (a.is_golden && !b.is_golden) return a.id;
  if (b.is_golden && !a.is_golden) return b.id;
  if ((a.contact_count || 0) !== (b.contact_count || 0)) {
    return (a.contact_count || 0) > (b.contact_count || 0) ? a.id : b.id;
  }
  const at = a.last_active_at ? Date.parse(a.last_active_at) : 0;
  const bt = b.last_active_at ? Date.parse(b.last_active_at) : 0;
  if (at !== bt) return at > bt ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
};

// Public: sweep one tenant. Pulls customers + their contact
// emails + external_ids, scores within-block pairs, upserts
// candidates above SUGGEST_PROB into customer_merge_candidates.
//
// Returns { ok, candidates_open, candidates_skipped, pairs_compared }.
export const sweepTenant = async (svc, { tenantId, opts = {} }) => {
  if (!svc || !tenantId) return { ok: false, error: "missing_args" };
  // 1. Load golden customers + their canonical emails + external ids.
  let customers = [];
  try {
    const r = await svc.from("customers")
      .select("id, customer_name, display_name, gstin, country, is_golden, contact_count, last_active_at, merge_blocked")
      .eq("tenant_id", tenantId)
      .eq("is_golden", true)
      .eq("merge_blocked", false)
      .limit(opts.maxCustomers || 5000);
    customers = r?.data || [];
  } catch (_e) { return { ok: false, error: "load_failed" }; }
  if (customers.length < 2) return { ok: true, candidates_open: 0, candidates_skipped: 0, pairs_compared: 0 };
  // 2. Pull contact emails + external IDs in two batches.
  try {
    const cIds = customers.map((c) => c.id);
    const [contactsR, extIdsR] = await Promise.all([
      svc.from("customer_contacts")
        .select("customer_id, email")
        .eq("tenant_id", tenantId)
        .in("customer_id", cIds),
      svc.from("customer_external_ids")
        .select("customer_id, system_code, external_id")
        .eq("tenant_id", tenantId)
        .in("customer_id", cIds),
    ]);
    const contactsByCustomer = new Map();
    for (const row of contactsR?.data || []) {
      if (!contactsByCustomer.has(row.customer_id)) contactsByCustomer.set(row.customer_id, []);
      if (row.email) contactsByCustomer.get(row.customer_id).push(row.email);
    }
    const extByCustomer = new Map();
    for (const row of extIdsR?.data || []) {
      if (!extByCustomer.has(row.customer_id)) extByCustomer.set(row.customer_id, []);
      extByCustomer.get(row.customer_id).push({ system_code: row.system_code, external_id: row.external_id });
    }
    customers = customers.map((c) => ({
      ...c,
      contact_emails: contactsByCustomer.get(c.id) || [],
      external_ids: extByCustomer.get(c.id) || [],
      identity_hash: identityHash(c),
    }));
  } catch (_e) { /* keep going with what we have */ }

  // 3. Group by block and pair within block.
  const blocks = groupByBlock(customers);
  let pairsCompared = 0;
  let candidatesOpen = 0;
  let candidatesSkipped = 0;
  for (const [_key, block] of blocks) {
    if (block.length > MAX_BLOCK_SIZE) { candidatesSkipped++; continue; }
    for (const [a, b] of blockPairs(block)) {
      pairsCompared++;
      const { probability, contributions } = scorePair(a, b);
      if (probability < SUGGEST_PROB) continue;
      const winner = chooseWinner(a, b);
      try {
        const ins = await svc.from("customer_merge_candidates").upsert({
          tenant_id: tenantId,
          customer_a_id: a.id,
          customer_b_id: b.id,
          probability,
          contributions,
          suggested_winner_id: winner,
          status: "open",
        }, { onConflict: "tenant_id,customer_a_id,customer_b_id" });
        if (!ins.error) candidatesOpen++;
      } catch (_e) { /* keep sweeping */ }
    }
  }
  return { ok: true, candidates_open: candidatesOpen, candidates_skipped: candidatesSkipped, pairs_compared: pairsCompared };
};

export const __test = {
  identityHash, blockingKey, observeFeatures, scoreObservations,
  chooseWinner, blockPairs,
  FEATURES, LAMBDA, SUGGEST_PROB, NAME_JARO_THRESHOLD, MAX_BLOCK_SIZE,
};
