// Per-customer adapter learning.
//
// Phase E1 of the DocAI robustness work. Today the adapter
// order in src/api/_lib/docai/index.js is a static list. Once a
// tenant has run dozens of extractions per customer, we have
// real signal about which adapter wins on that customer's PO
// layout: a customer whose POs come out of SAP almost always
// parses best with Reducto; one whose POs are scanned tables
// almost always benefits from Mistral OCR + Claude.
//
// This module reads extraction_runs for a given (tenant,
// customer) pair, scores each adapter by per-run success
// (adapter_used + status='ok' + confidence_overall), and
// returns a reordered adapter list the dispatcher can use as
// its first-try sequence.
//
// Decisions deliberately stay conservative:
//   - Need MIN_OBSERVATIONS runs per adapter before we
//     consider learning anything. Below that, fall through to
//     the static default order so we never bias on noise.
//   - Score = (recent ok rate) * (mean confidence). Both
//     factors matter; an adapter that returns ok=true with
//     0.4 confidence is worse than one that fails fast.
//   - Recency-weighted: the last 60 days carry more weight
//     than older runs (a half-life-style decay).
//   - Cache the result per (tenant, customer) for 30 minutes
//     to keep the dispatcher's per-call latency at
//     "one extra Postgres select" rather than a full window
//     scan every PO.

const DEFAULT_ORDER = ["docling", "marker", "unstructured", "reducto", "azure_di", "claude", "gemini"];
const MIN_OBSERVATIONS = 5;
const RECENT_WINDOW_DAYS = 90;
const HALF_LIFE_DAYS = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Module-level cache so the dispatcher's per-call cost is one
// Map lookup. Keyed by tenant + customer. The DB scan happens
// at most twice per hour per (tenant, customer).
const cache = new Map();

const cacheKey = (tenantId, customerId) => String(tenantId) + ":" + String(customerId || "_global");

const decayWeight = (run, now) => {
  // exp(-ln2 * age / halfLife). At HALF_LIFE_DAYS the weight
  // is 0.5; at 0 days it is 1; at >>halfLife it tends to 0.
  const ageMs = now - new Date(run.created_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const ageDays = ageMs / (24 * 3600 * 1000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
};

// Score one adapter: weighted-mean (ok-rate * mean-confidence), optionally
// times a correction factor. Returns null when below MIN_OBSERVATIONS so the
// caller can fall through to the static order.
//
// correctionAware (dark, opt-in): self-reported confidence is not the same as
// correctness. An adapter can return ok=true with 0.9 confidence yet the
// operator edits five fields. When each ok run carries a `correction_count`
// (operator edits from extraction_corrections), we multiply by
// 1 / (1 + meanCorrectionsPerOkRun) — 0 edits -> factor 1.0, ~3 edits -> 0.25 —
// so the ranking optimizes the TRUE objective (fewest operator corrections),
// not the model's self-assessment. meanCorr is over OK runs only; a failed run
// has nothing to correct and is already penalized via okRate.
const scoreOne = (adapterRuns, now, correctionAware = false) => {
  if (!Array.isArray(adapterRuns) || adapterRuns.length < MIN_OBSERVATIONS) return null;
  let weightSum = 0;
  let okSum = 0;
  let confSum = 0;
  let okWeightSum = 0;
  let corrSum = 0;
  for (const run of adapterRuns) {
    const w = decayWeight(run, now);
    weightSum += w;
    const isOk = run.status === "ok";
    okSum += (isOk ? 1 : 0) * w;
    const conf = isOk ? Number(run.confidence_overall) || 0 : 0;
    confSum += conf * w;
    if (isOk) {
      okWeightSum += w;
      corrSum += (Number(run.correction_count) || 0) * w;
    }
  }
  if (weightSum === 0) return null;
  const okRate = okSum / weightSum;
  const meanConf = confSum / weightSum;
  let correctionFactor = 1;
  if (correctionAware && okWeightSum > 0) {
    const meanCorr = corrSum / okWeightSum;
    correctionFactor = 1 / (1 + meanCorr);
  }
  return okRate * meanConf * correctionFactor;
};

// Public: get the reordered adapter list for a (tenant,
// customer) pair. Adapters with insufficient observations sit
// at their default position; adapters with scores get sorted by
// score desc and moved to the front.
export const rankAdaptersForCustomer = async ({
  svc, tenantId, customerId, defaultOrder = DEFAULT_ORDER,
  // Dark by default: only folds operator-correction rate into the score when
  // explicitly enabled (env or caller). Off -> byte-identical + no extra query.
  correctionAware = process.env.ADAPTER_LEARNING_CORRECTION_AWARE === "1",
} = {}) => {
  const key = cacheKey(tenantId, customerId) + (correctionAware ? ":ca" : "");
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.order;

  const since = new Date(now - RECENT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  let runs = [];
  try {
    const r = await svc.from("extraction_runs")
      .select("id, adapter_used, status, confidence_overall, created_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .gt("created_at", since)
      .limit(500);
    if (!r.error && Array.isArray(r.data)) runs = r.data;
  } catch (_e) { /* tolerate; fall back to default */ }

  // Attach per-run operator-correction counts (only when correction-aware).
  if (correctionAware && runs.length) {
    const runIds = runs.map((x) => x.id).filter(Boolean);
    const counts = new Map();
    try {
      const c = await svc.from("extraction_corrections")
        .select("extraction_run_id")
        .eq("tenant_id", tenantId)
        .in("extraction_run_id", runIds);
      for (const row of (c.data || [])) {
        counts.set(row.extraction_run_id, (counts.get(row.extraction_run_id) || 0) + 1);
      }
    } catch (_e) { /* tolerate; degrade to confidence-only scoring */ }
    for (const run of runs) run.correction_count = counts.get(run.id) || 0;
  }

  const byAdapter = new Map();
  for (const run of runs) {
    if (!run.adapter_used) continue;
    if (!byAdapter.has(run.adapter_used)) byAdapter.set(run.adapter_used, []);
    byAdapter.get(run.adapter_used).push(run);
  }
  const scored = [];
  for (const [adapter, list] of byAdapter) {
    const s = scoreOne(list, now, correctionAware);
    if (s != null) scored.push({ adapter, score: s, observations: list.length });
  }
  scored.sort((a, b) => b.score - a.score);
  const learnedOrder = scored.map((x) => x.adapter);
  // Compose: learned-ranked adapters first, then any default
  // adapter not yet in the learned list (so a brand-new
  // adapter the tenant hasn't tried yet still gets a slot in
  // the fallback chain).
  const merged = [...learnedOrder];
  for (const a of defaultOrder) {
    if (!merged.includes(a)) merged.push(a);
  }
  cache.set(key, { order: merged, expires: now + CACHE_TTL_MS, scored });
  return merged;
};

// Cache-eviction helper for tests + a manual operator override
// (admin endpoint not built yet; reserved for follow-up).
export const __clearCache = () => { cache.clear(); };

export const __test = { scoreOne, decayWeight, MIN_OBSERVATIONS, HALF_LIFE_DAYS, CACHE_TTL_MS, DEFAULT_ORDER };
