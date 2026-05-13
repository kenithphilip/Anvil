// N-of-M auto-promote of consistent mappings (Wave CM 3.1).
//
// Today every new mapping requires an operator click on the
// recon table. For high-volume customers, the same
// (customer_part_number -> item_id) pair shows up across many
// orders before the operator finds time to confirm. This wave
// detects those de-facto consensus mappings and promotes them
// to a confirmed item_customer_parts row automatically.
//
// Promotion rules:
//
//   1. The mapping must appear in N-of-M most recent
//      extraction_runs for this (tenant, customer,
//      customer_part_number) tuple. Default 3-of-4.
//   2. Every observation must have model confidence
//      >= MIN_OBSERVATION_CONFIDENCE (default 0.85).
//   3. No operator-confirmed correction within the same window
//      may DISAGREE with the proposed mapping. A correction to
//      the same item_id is fine; a correction to a different
//      item_id blocks promotion forever (until cleared).
//   4. The mapping must NOT already exist as an active row
//      (CM 2.1 invariant).
//   5. created_via stamps 'auto_consensus' with
//      confidence_pct = 90 (slightly under manual=100, slightly
//      over quote_sent=95 because consensus across runs is a
//      stronger signal than a single quote send).
//
// The operator can revoke any auto-promoted row from the
// drawer; revoking sets valid_to = today so the CM 2.1
// invariant lets a replacement land.
//
// Designed as a cron job (every 4 hours) so the resolver gets
// to use freshly-promoted mappings on the next intake without
// the operator having to do anything.
//
// Pure I/O: this module pulls data, decides, writes. No LLM
// calls. The "consensus" signal is already in the database
// from the docai pipeline's normalized_extract.

const DEFAULT_N = 3;
const DEFAULT_M = 4;
const MIN_OBSERVATION_CONFIDENCE = 0.85;

// Extract (customer_part_number -> item_id) tuples from one
// normalized_extract payload. Lines without a customer_part_number
// or without a resolved _mapped_item are skipped.
export const extractTuplesFromRun = (normalized) => {
  if (!normalized?.lines || !Array.isArray(normalized.lines)) return [];
  const out = [];
  for (const line of normalized.lines) {
    const mapped = line?._mapped_item;
    if (!mapped?.id) continue;
    // Skip mappings that were just-now produced by the LLM
    // suggest tier (not yet confirmed). Only count rows where
    // the resolver had stable evidence.
    const via = mapped.match_via;
    if (via === "llm_suggest") continue;
    const partNo = line.partNumber || line.partNo || line.itemCode || line.customer_part_number || "";
    const norm = String(partNo).trim().toUpperCase();
    if (!norm) continue;
    out.push({
      customer_part_number: norm,
      item_id: mapped.id,
      match_via: via,
      part_no: mapped.part_no,
    });
  }
  return out;
};

// Group observations per (customer_part_number) and find
// candidates where the same item_id won >= N times in the last
// M runs. Returns:
//   [{ customer_part_number, item_id, occurrences, total_runs,
//      match_via_breakdown }]
export const findConsensusCandidates = (observationsPerRun, opts = {}) => {
  const n = Number(opts.n) || DEFAULT_N;
  const m = Number(opts.m) || DEFAULT_M;
  // observationsPerRun is an ordered (newest-first) array of
  // arrays. We collapse to per-part-number tallies over the
  // M most-recent runs.
  const slice = observationsPerRun.slice(0, m);
  const tally = new Map();   // part_no -> { item_id -> { count, vias } }
  let totalRuns = 0;
  for (const run of slice) {
    totalRuns++;
    if (!Array.isArray(run) || !run.length) continue;
    // De-dupe within a run so a multi-line PO with the same
    // (part_no -> item_id) on three lines doesn't count thrice.
    const seenInRun = new Set();
    for (const obs of run) {
      const key = obs.customer_part_number + "|" + obs.item_id;
      if (seenInRun.has(key)) continue;
      seenInRun.add(key);
      if (!tally.has(obs.customer_part_number)) tally.set(obs.customer_part_number, new Map());
      const byItem = tally.get(obs.customer_part_number);
      if (!byItem.has(obs.item_id)) byItem.set(obs.item_id, { count: 0, vias: [] });
      const slot = byItem.get(obs.item_id);
      slot.count++;
      slot.vias.push(obs.match_via);
    }
  }
  const candidates = [];
  for (const [partNo, byItem] of tally) {
    // Conflict check: if MORE THAN ONE item_id won >= 1 time
    // for the same partNo, the customer is sending mixed
    // signal; skip promotion (operator must reconcile).
    if (byItem.size > 1) continue;
    const [itemId, slot] = byItem.entries().next().value;
    if (slot.count < n) continue;
    candidates.push({
      customer_part_number: partNo,
      item_id: itemId,
      occurrences: slot.count,
      total_runs: totalRuns,
      match_via_breakdown: slot.vias.reduce((acc, v) => {
        acc[v || "unknown"] = (acc[v || "unknown"] || 0) + 1;
        return acc;
      }, {}),
    });
  }
  return candidates;
};

// Find recent extractions for one (tenant, customer) and
// surface the per-part tuples. Returns observationsPerRun
// (array of arrays).
export const loadRecentObservations = async (svc, { tenantId, customerId, lookbackRuns = 8 }) => {
  if (!svc || !tenantId || !customerId) return [];
  try {
    const r = await svc.from("extraction_runs")
      .select("id, normalized_extract, confidence_overall, started_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("status", "ok")
      .gte("confidence_overall", MIN_OBSERVATION_CONFIDENCE)
      .order("started_at", { ascending: false })
      .limit(lookbackRuns);
    const runs = r?.data || [];
    return runs.map((row) => extractTuplesFromRun(row.normalized_extract));
  } catch (_e) { return []; }
};

// Check whether the operator has ever explicitly DISAGREED with
// a proposed mapping. We look at learned_corrections (Wave 3.3
// docai) for a recent operator-confirmed change away from the
// proposed item_id on the same customer + partNo.
export const hasDisagreement = async (svc, { tenantId, customerId, customerPartNo, proposedItemId, lookbackDays = 90 }) => {
  if (!svc || !tenantId || !customerId) return false;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await svc.from("learned_corrections")
      .select("field_path, model_value, operator_value, created_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .gte("created_at", cutoff)
      .ilike("field_path", "%customer_part_number%");
    const rows = r?.data || [];
    for (const row of rows) {
      // The operator changed the customer_part_number on a line
      // away from the proposed mapping; treat as disagreement
      // when operator_value differs from the proposal.
      const op = row.operator_value;
      if (op == null) continue;
      const opStr = typeof op === "object" ? JSON.stringify(op) : String(op);
      if (!opStr.includes(customerPartNo) && !opStr.includes(proposedItemId)) {
        return true;
      }
    }
    return false;
  } catch (_e) { return false; }
};

// Public entry. Sweeps one (tenant, customer) and auto-promotes
// any consensus mappings that don't already exist. Returns
// counts so the cron can log + alert.
export const sweepCustomer = async (svc, { tenantId, customerId, opts = {} }) => {
  if (!svc || !tenantId || !customerId) return { ok: false, error: "missing_args" };
  const observations = await loadRecentObservations(svc, {
    tenantId, customerId, lookbackRuns: opts.lookbackRuns || DEFAULT_M * 2,
  });
  const candidates = findConsensusCandidates(observations, {
    n: opts.n, m: opts.m,
  });
  if (!candidates.length) return { ok: true, promoted: 0, candidates: 0 };
  // For each candidate, check existing active mapping (CM 2.1)
  // and operator disagreement (above).
  let existingActive = new Map();
  try {
    const r = await svc.from("item_customer_parts")
      .select("customer_part_number, item_id, valid_to")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId);
    for (const row of r?.data || []) {
      // CM 2.1: "active" means valid_to IS NULL.
      if (row.valid_to == null) {
        existingActive.set(String(row.customer_part_number).toUpperCase(), row.item_id);
      }
    }
  } catch (_e) { /* fall through; treat as no existing */ }
  let promoted = 0;
  for (const cand of candidates) {
    if (existingActive.has(cand.customer_part_number)) continue;
    const disagreement = await hasDisagreement(svc, {
      tenantId, customerId,
      customerPartNo: cand.customer_part_number,
      proposedItemId: cand.item_id,
      lookbackDays: opts.disagreementWindowDays || 90,
    });
    if (disagreement) continue;
    try {
      const ins = await svc.from("item_customer_parts").insert({
        tenant_id: tenantId,
        item_id: cand.item_id,
        customer_id: customerId,
        customer_part_number: cand.customer_part_number,
        applies_to: ["sales_order"],
        created_via: "auto_consensus",
        confidence_pct: 90,
        confirmed_at: new Date().toISOString(),
      });
      if (!ins.error) promoted++;
    } catch (_e) { /* keep sweeping */ }
  }
  return { ok: true, promoted, candidates: candidates.length };
};

export const __test = { DEFAULT_N, DEFAULT_M, MIN_OBSERVATION_CONFIDENCE };
