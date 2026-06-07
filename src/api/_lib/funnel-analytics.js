// Funnel data layer: stage-event capture + daily aggregation.
//
// Two responsibilities, both pure-ish I/O helpers (the HTTP handler /
// cron supplies the supabase service client):
//
//   recordStageEvent — append one opportunity_stage_events row when an
//     opportunity changes stage (or is created). Computes dwell time in
//     the prior stage. The raw signal funnel analytics is built on; it
//     cannot be backfilled once lost, so capture starts at write time.
//
//   refreshFunnel — materialise analytics_funnel_daily for a tenant:
//     entered/exited per (day, stage) from the immutable events (recompute
//     -safe), plus a count/value/age snapshot for the run's own day. A
//     daily cron accrues a real per-day time series going forward.
//
// Mirrors the analytics family in _lib/winloss.js (idempotent upserts).

// Stages that are terminal outcomes, not active funnel positions. We
// keep them out of the "currently in stage" snapshot but still count
// transitions into them (entered) so conversion can be measured.
export const TERMINAL_STAGES = new Set(["CLOSE_WON", "CLOSE_LOST", "REGRETTED"]);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const median = (arr) => {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

// Nearest-rank percentile (p in 0..100).
const percentile = (arr, p) => {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return round2(s[Math.min(s.length - 1, Math.max(0, rank - 1))]);
};

const dayOf = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

// Append a stage-transition event. Best-effort dwell computation:
// time since this opp's most recent prior event, falling back to the
// opportunity's created_at. Returns { ok, days_in_from_stage }.
export const recordStageEvent = async (svc, {
  tenantId, opportunityId, fromStage = null, toStage,
  changedBy = null, ownerId = null, amountInr = null, probability = null,
  source = "live", changedAt = null,
}) => {
  if (!svc || !tenantId || !opportunityId || !toStage) {
    return { ok: false, error: "missing_args" };
  }
  const at = changedAt || new Date().toISOString();

  let daysInFrom = null;
  try {
    const prev = await svc.from("opportunity_stage_events")
      .select("changed_at")
      .eq("tenant_id", tenantId).eq("opportunity_id", opportunityId)
      .order("changed_at", { ascending: false }).limit(1).maybeSingle();
    let baseIso = prev?.data?.changed_at || null;
    if (!baseIso) {
      const opp = await svc.from("opportunities")
        .select("created_at").eq("tenant_id", tenantId).eq("id", opportunityId).maybeSingle();
      baseIso = opp?.data?.created_at || null;
    }
    if (baseIso) {
      const d = (new Date(at).getTime() - new Date(baseIso).getTime()) / 86400000;
      if (Number.isFinite(d) && d >= 0) daysInFrom = round2(d);
    }
  } catch (_e) { /* dwell is best-effort; never block capture */ }

  const r = await svc.from("opportunity_stage_events").insert({
    tenant_id: tenantId,
    opportunity_id: opportunityId,
    from_stage: fromStage,
    to_stage: toStage,
    changed_at: at,
    changed_by: changedBy,
    owner_id: ownerId,
    amount_inr: amountInr,
    probability,
    days_in_from_stage: daysInFrom,
    source,
  });
  if (r.error) return { ok: false, error: r.error.message };
  return { ok: true, days_in_from_stage: daysInFrom };
};

// Materialise analytics_funnel_daily for one tenant.
// `today` override is for deterministic tests.
export const refreshFunnel = async (svc, tenantId, { sinceDays = 90, today = null } = {}) => {
  const now = today ? new Date(today) : new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - sinceDays * 86400_000).toISOString();
  const stamp = new Date().toISOString();

  // 1. entered/exited per (day, stage) from the immutable event log.
  const events = await svc.from("opportunity_stage_events")
    .select("from_stage, to_stage, changed_at")
    .eq("tenant_id", tenantId).gte("changed_at", since);
  if (events.error) throw new Error("funnel/events: " + events.error.message);
  const dayStage = new Map();
  const bump = (day, stage, field) => {
    if (!day || !stage) return;
    const k = day + "|" + stage;
    let b = dayStage.get(k);
    if (!b) { b = { day, stage, entered: 0, exited: 0 }; dayStage.set(k, b); }
    b[field] += 1;
  };
  for (const e of events.data || []) {
    const day = dayOf(e.changed_at);
    bump(day, e.to_stage, "entered");
    if (e.from_stage) bump(day, e.from_stage, "exited");
  }

  // 2. Snapshot the current open funnel (count / value / age per stage).
  const opps = await svc.from("opportunities")
    .select("id, stage, amount_inr, probability, created_at")
    .eq("tenant_id", tenantId)
    .not("stage", "in", "(CLOSE_WON,CLOSE_LOST,REGRETTED)");
  if (opps.error) throw new Error("funnel/opps: " + opps.error.message);

  // Latest event per open opp, for age-in-stage (one round trip).
  const oppIds = (opps.data || []).map((o) => o.id);
  const latestByOpp = new Map();
  if (oppIds.length) {
    const evs = await svc.from("opportunity_stage_events")
      .select("opportunity_id, changed_at")
      .eq("tenant_id", tenantId).in("opportunity_id", oppIds)
      .order("changed_at", { ascending: false });
    for (const ev of evs.data || []) {
      if (!latestByOpp.has(ev.opportunity_id)) latestByOpp.set(ev.opportunity_id, ev.changed_at);
    }
  }

  const byStage = new Map();
  for (const o of opps.data || []) {
    let s = byStage.get(o.stage);
    if (!s) { s = { count: 0, value: 0, weighted: 0, ages: [] }; byStage.set(o.stage, s); }
    s.count += 1;
    const v = Number(o.amount_inr || 0);
    s.value += v;
    const p = Number(o.probability);
    s.weighted += v * (Number.isFinite(p) ? p / 100 : 0);
    const baseIso = latestByOpp.get(o.id) || o.created_at;
    if (baseIso) {
      const age = (now.getTime() - new Date(baseIso).getTime()) / 86400_000;
      if (Number.isFinite(age) && age >= 0) s.ages.push(age);
    }
  }

  // 3a. Upsert entered/exited for every (day, stage) in the window.
  // Partial-column upsert: on conflict only entered/exited are updated,
  // so historical snapshot columns on past-day rows are preserved.
  let dayStageRows = 0;
  for (const b of dayStage.values()) {
    const r = await svc.from("analytics_funnel_daily").upsert({
      tenant_id: tenantId, day: b.day, stage: b.stage,
      entered: b.entered, exited: b.exited, updated_at: stamp,
    }, { onConflict: "tenant_id,day,stage" });
    if (r.error) throw new Error("funnel/upsert_flow: " + r.error.message);
    dayStageRows += 1;
  }

  // 3b. Upsert today's snapshot columns (entered/exited untouched).
  for (const [stage, s] of byStage.entries()) {
    const r = await svc.from("analytics_funnel_daily").upsert({
      tenant_id: tenantId, day: todayStr, stage,
      count_in_stage: s.count,
      value_in_stage: round2(s.value),
      weighted_value_in_stage: round2(s.weighted),
      median_age_days: median(s.ages),
      p90_age_days: percentile(s.ages, 90),
      updated_at: stamp,
    }, { onConflict: "tenant_id,day,stage" });
    if (r.error) throw new Error("funnel/upsert_snapshot: " + r.error.message);
  }

  return {
    tenant_id: tenantId,
    since_days: sinceDays,
    day: todayStr,
    stages_snapshotted: byStage.size,
    day_stage_rows: dayStageRows,
  };
};

export const __test__ = { median, percentile, round2, dayOf };
