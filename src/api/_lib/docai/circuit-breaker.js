// A circuit breaker per LLM provider (gemini, claude), shared across
// serverless instances by reading the tenant's own extraction runs.
//
// On 2026-10-07 run f0e2b29a read a 6-page PO with the order
// [gemini, ..., claude] plus LlamaParse. Gemini answered 503 "high demand" on
// its primary model and then on its fallback model, about 10s each, so it
// spent 20.7s. Claude was then skipped (skipped_insufficient_budget) and
// LlamaParse timed out. Five more runs that day hit the same overload. An
// overload like that lasts minutes to hours, so every run paid about 20s to
// learn what the run before it had already learned, and that time came out of
// Claude's and LlamaParse's share.
//
// The evidence is already persisted. Every run writes
// extraction_runs.adapter_attempts, and since #562 a failed attempt carries a
// structured failure_class (overload | rate_limited | timeout | ...) and, when
// it called more than one model, a `models` list. So the breaker needs no
// table. Its state is derived from the tenant's recent runs:
//
//   OPEN       the provider's latest overload is less than N minutes old, it
//              was overloaded on EVERY model it tried, and no later attempt of
//              that provider succeeded. The dispatcher skips it with status
//              skipped_circuit_open and gives its time to the next adapters.
//   HALF_OPEN  that overload is N or more minutes old and nothing has
//              succeeded since. The provider is tried once. A success closes
//              the breaker; another overload opens it again for N minutes.
//   CLOSED     anything else. The provider runs as usual.
//
// N is DOCAI_BREAKER_MINUTES (default 10). 0 turns the breaker off.
//
// Scope and safety:
//   - Tenant-scoped. The query filters on tenant_id, the cache is keyed by
//     it, and without a tenant id there is no query and no breaker.
//   - Fail safe. A query error, an odd row or a missing client all read as
//     CLOSED: the breaker can only ever save time, never stop a provider it
//     has no evidence against.
//   - A run copied by the dedupe short-circuit (status_reason 'dedupe_hit')
//     carries an older run's attempts, so it is not evidence and is ignored.
//   - One query per tenant per warm instance per CACHE_TTL_MS (30s). This
//     instance's own outcomes are layered on top at once, so a later chunk or
//     run on the same instance does not wait for the cache to expire.

export const BREAKER_PROVIDERS = Object.freeze(["gemini", "claude"]);
export const isBreakerProvider = (name) => BREAKER_PROVIDERS.includes(name);

export const CIRCUIT_OPEN_STATUS = "skipped_circuit_open";

export const DEFAULT_BREAKER_MINUTES = 10;
export const CACHE_TTL_MS = 30_000;

// A run that started just before the window can finish inside it, and its
// attempts are dated by when it finished. 60s is the function ceiling.
const RUN_SLACK_MS = 60_000;
// Enough rows to see the latest outcome for each provider on a busy tenant.
const ROW_LIMIT = 100;
// A half-open trial that never reported back (the function was killed) stops
// blocking other requests after this long.
const TRIAL_TTL_MS = 60_000;

const OK_STATUSES = new Set(["ok", "low_confidence"]);
// HTTP statuses that mean "overloaded" when an older row did not record a
// per-model failure_class (rows written before this change).
const OVERLOAD_HTTP = new Set([503, 529]);

/**
 * N, the breaker window in minutes. Read on every call so a deployment can
 * change it without a cold start. Blank or invalid means the default; 0 (or
 * a negative number) turns the breaker off.
 */
export const breakerMinutes = (raw = process.env.DOCAI_BREAKER_MINUTES) => {
  if (raw == null || String(raw).trim() === "") return DEFAULT_BREAKER_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BREAKER_MINUTES;
  if (n <= 0) return 0;
  return Math.min(n, 24 * 60);
};

const modelOverloaded = (m) => (m?.failure_class
  ? m.failure_class === "overload"
  : OVERLOAD_HTTP.has(Number(m?.status)));

/**
 * Was this attempt an overload on every model it tried?
 *
 * The attempt's own failure_class describes its LAST call. When it called
 * more than one model (Gemini's #562 fallback model), each model's last call
 * must have been an overload too: a primary that was overloaded and a
 * fallback that timed out does not show the provider is out of capacity.
 */
export const overloadedOnEveryModel = (attempt) => {
  if (!attempt || attempt.status !== "failed" || attempt.failure_class !== "overload") return false;
  const models = Array.isArray(attempt.models) ? attempt.models : [];
  if (!models.length) return true;
  const lastByModel = new Map();
  for (const m of models) lastByModel.set(String(m?.model || ""), m);
  return [...lastByModel.values()].every(modelOverloaded);
};

const eventOf = (attempt, at) => {
  if (!attempt || !isBreakerProvider(attempt.adapter)) return null;
  if (OK_STATUSES.has(attempt.status)) return { provider: attempt.adapter, at, kind: "success" };
  if (overloadedOnEveryModel(attempt)) return { provider: attempt.adapter, at, kind: "overload" };
  return null;
};

/**
 * Breaker events from extraction_runs rows. An attempt is dated by its run's
 * finished_at (started_at while a row has none), which is at most one run
 * budget after the call itself.
 */
export const eventsFromRows = (rows) => {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.status_reason === "dedupe_hit") continue;
    const at = Date.parse(row.finished_at || row.started_at || "");
    if (!Number.isFinite(at)) continue;
    for (const a of Array.isArray(row.adapter_attempts) ? row.adapter_attempts : []) {
      const e = eventOf(a, at);
      if (e) out.push(e);
    }
  }
  return out;
};

const iso = (ms) => new Date(ms).toISOString();

/**
 * The breaker state for one provider, from its events.
 *
 * Events older than 2N minutes are ignored: by then the provider has been
 * half-open for N minutes, and an overload that old says nothing. A success
 * at the same time as an overload (two chunks of one run) wins, so a tie
 * always resolves toward trying the provider.
 */
export const deriveBreakerState = (events, provider, { now, minutes }) => {
  const windowMs = minutes * 60_000;
  const from = now - 2 * windowMs;
  let lastOverload = null;
  let lastSuccess = null;
  const mine = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.provider === provider && e.at >= from && e.at <= now);
  for (const e of mine) {
    if (e.kind === "success") lastSuccess = lastSuccess == null ? e.at : Math.max(lastSuccess, e.at);
    else if (e.kind === "overload") lastOverload = lastOverload == null ? e.at : Math.max(lastOverload, e.at);
  }
  if (lastOverload == null || (lastSuccess != null && lastSuccess >= lastOverload)) return { state: "closed" };
  // When it opened: the first overload since the last success.
  const openedAt = Math.min(...mine
    .filter((e) => e.kind === "overload" && (lastSuccess == null || e.at > lastSuccess))
    .map((e) => e.at));
  const halfOpenAt = lastOverload + windowMs;
  return {
    state: now < halfOpenAt ? "open" : "half_open",
    opened_at: iso(openedAt),
    last_overload_at: iso(lastOverload),
    half_open_at: iso(halfOpenAt),
  };
};

// tenantId -> { fetchedAt, events } (the last query), and
// tenantId -> [events] (this instance's own outcomes since).
const snapshots = new Map();
const localEvents = new Map();
// tenantId + ":" + provider -> when a half-open trial was claimed.
const trials = new Map();

const fetchEvents = async ({ svc, tenantId, now, minutes }) => {
  const since = iso(now - 2 * minutes * 60_000 - RUN_SLACK_MS);
  const res = await svc.from("extraction_runs")
    .select("started_at,finished_at,status_reason,adapter_attempts")
    .eq("tenant_id", tenantId)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(ROW_LIMIT);
  if (!res || res.error || !Array.isArray(res.data)) return [];
  return eventsFromRows(res.data);
};

/**
 * Read every provider's breaker for a tenant. Returns null when the breaker
 * is off or there is no tenant, else { minutes, states: { gemini, claude } }.
 * Never throws.
 */
export const readCircuitBreakers = async ({ svc, tenantId, now = Date.now() } = {}) => {
  const minutes = breakerMinutes();
  if (!minutes || !tenantId) return null;
  const key = String(tenantId);
  let snap = snapshots.get(key);
  const age = snap ? now - snap.fetchedAt : Infinity;
  if (!snap || age < 0 || age >= CACHE_TTL_MS) {
    let events = [];
    try { events = svc ? await fetchEvents({ svc, tenantId, now, minutes }) : []; }
    catch { events = []; }
    snap = { fetchedAt: now, events };
    snapshots.set(key, snap);
  }
  const local = (localEvents.get(key) || []).filter((e) => e.at >= now - 2 * minutes * 60_000);
  localEvents.set(key, local);
  const all = snap.events.concat(local);
  const states = {};
  for (const p of BREAKER_PROVIDERS) states[p] = deriveBreakerState(all, p, { now, minutes });
  return { minutes, states };
};

/**
 * Claim the one half-open trial for (tenant, provider) on this instance.
 * False while another request here is already trying the provider.
 */
export const claimHalfOpenTrial = ({ tenantId, provider, now = Date.now() }) => {
  const key = String(tenantId) + ":" + provider;
  const at = trials.get(key);
  if (at != null && now >= at && now - at < TRIAL_TTL_MS) return false;
  trials.set(key, now);
  return true;
};

/**
 * Record this instance's outcome for a provider, so the next chunk or run
 * here sees it before the cache expires. `trial` releases the half-open trial
 * this attempt claimed. `attempt` is the dispatcher's attempt record, the
 * shape persisted on extraction_runs.adapter_attempts.
 */
export const noteCircuitOutcome = ({ tenantId, attempt, trial = false, now = Date.now() }) => {
  if (!tenantId || !attempt || !isBreakerProvider(attempt.adapter)) return;
  if (trial) trials.delete(String(tenantId) + ":" + attempt.adapter);
  if (!breakerMinutes()) return;
  const e = eventOf(attempt, now);
  if (!e) return;
  const key = String(tenantId);
  const list = localEvents.get(key) || [];
  list.push(e);
  localEvents.set(key, list);
};

/**
 * The attempt record for a provider the breaker skipped.
 */
export const circuitOpenAttempt = (adapter, circuit, minutes, reason = "provider_overloaded_recently") => ({
  adapter,
  status: CIRCUIT_OPEN_STATUS,
  reason,
  opened_at: circuit?.opened_at || null,
  last_overload_at: circuit?.last_overload_at || null,
  half_open_at: circuit?.half_open_at || null,
  window_minutes: minutes,
});

// Tests only: forget every snapshot, local outcome and trial.
export const __resetCircuitBreakers = () => {
  snapshots.clear();
  localEvents.clear();
  trials.clear();
};
