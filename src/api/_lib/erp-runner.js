// Shared ERP connector runtime.
//
// All Anvil ERP connectors (NetSuite v2, Tally v2, SAP, Dynamics 365,
// Acumatica) follow the same control-plane shape:
//
//   - credentials live on tenant_settings, encrypted via secrets.js
//   - per-entity sync state with a high-water cursor
//   - per-tick audit row in <erp>_sync_runs
//   - failed pushes land in <erp>_retry_queue with exponential backoff
//   - manual triggers run scoped to the caller's tenant
//
// This module factors out the orchestration so each per-ERP file
// only declares the entity definitions (SQL / wire format / row
// upsert) and the auth/HTTP shape.
//
// Each ERP's sync_runs and retry_queue tables share a column shape
// (see migrations 015, 016, 017, 018, 019). We reference the table
// name via the `tablePrefix` argument so one runner serves all five.

const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];

// Open a sync run row, returns the inserted id.
export const openSyncRun = async (svc, prefix, { tenantId, entity, triggeredBy, companyId }) => {
  const row = { tenant_id: tenantId, entity, status: "running", triggered_by: triggeredBy };
  if (companyId !== undefined) row.company_id = companyId;
  const ins = await svc.from(prefix + "_sync_runs").insert(row).select("id").single();
  return ins.data?.id || null;
};

export const closeSyncRun = async (svc, prefix, runId, patch) => {
  if (!runId) return;
  await svc.from(prefix + "_sync_runs")
    .update({ run_finished_at: new Date().toISOString(), ...patch })
    .eq("id", runId);
};

// Generic retry-queue runner. Caller supplies a replay function that,
// given the row, returns either { ok: true, externalId, ... } or
// { ok: false, status, error }. Recoverable failures schedule the
// next retry; permanent failures or attempts >= max flip status to
// gave_up.
export const drainRetryQueue = async (svc, prefix, { tenantId, opts, replay, isRecoverable }) => {
  const q = svc.from(prefix + "_retry_queue").select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(opts?.limit || 50);
  if (opts?.id) q.eq("id", opts.id);
  const rows = await q;
  if (rows.error) throw new Error("retry queue read: " + rows.error.message);
  const out = [];
  for (const row of rows.data || []) {
    const result = await replay(row).catch((err) => ({
      ok: false, status: 0, error: err?.message || String(err),
    }));
    if (result.ok) {
      await svc.from(prefix + "_retry_queue").update({
        status: "succeeded",
        attempt_count: (row.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", row.id);
      out.push({ id: row.id, ok: true, ...result });
    } else if (isRecoverable(result.status)) {
      const nextAttempt = (row.attempt_count || 0) + 1;
      if (nextAttempt >= (row.max_attempts || 5)) {
        await svc.from(prefix + "_retry_queue").update({
          status: "gave_up",
          attempt_count: nextAttempt,
          last_attempt_at: new Date().toISOString(),
          last_error: "gave_up::status=" + result.status + "::" + (result.error || ""),
        }).eq("id", row.id);
        out.push({ id: row.id, gave_up: true, ...result });
      } else {
        const minutes = BACKOFF_MIN[Math.min(nextAttempt, BACKOFF_MIN.length - 1)];
        await svc.from(prefix + "_retry_queue").update({
          attempt_count: nextAttempt,
          last_attempt_at: new Date().toISOString(),
          next_attempt_at: new Date(Date.now() + minutes * 60_000).toISOString(),
          last_error: result.error,
        }).eq("id", row.id);
        out.push({ id: row.id, ok: false, attempt: nextAttempt, retry_in_min: minutes, error: result.error });
      }
    } else {
      // Permanent failure.
      await svc.from(prefix + "_retry_queue").update({
        status: "gave_up",
        attempt_count: (row.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: "permanent::status=" + result.status + "::" + (result.error || ""),
      }).eq("id", row.id);
      out.push({ id: row.id, gave_up: true, permanent: true, ...result });
    }
  }
  return { processed: out.length, results: out };
};

// Generic isRecoverable used by all ERP connectors.
export const httpIsRecoverable = (status) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

// Convenience: run an entity sync inside an audit row, capture
// pulled/inserted/updated/errored counts, persist to sync_state and
// sync_runs. The `runner` argument is a function that receives
// (since) and returns { pulled, inserted, updated, errored, highWater }.
export const runSyncEntity = async (svc, prefix, { tenantId, entity, triggeredBy, full, companyId, runner }) => {
  const runId = await openSyncRun(svc, prefix, { tenantId, entity, triggeredBy, companyId });
  try {
    const stateQ = await svc.from(prefix + "_sync_state")
      .select("*").eq("tenant_id", tenantId).eq("entity", entity).maybeSingle();
    const state = stateQ.data || null;
    const since = full ? null : (state?.last_modified_high_water || null);
    const result = await runner(since);
    const { pulled = 0, inserted = 0, updated = 0, errored = 0, highWater = null } = result || {};
    // Upsert sync_state.
    const patch = {
      status: errored > 0 ? "partial" : "idle",
      last_sync_at: new Date().toISOString(),
      rows_pulled: pulled,
      records_inserted: inserted,
      records_updated: updated,
      records_errored: errored,
      ...(highWater ? { last_modified_high_water: highWater } : {}),
      ...(full ? { last_full_sync_at: new Date().toISOString() } : {}),
      error: null,
    };
    if (state?.id) {
      await svc.from(prefix + "_sync_state").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", state.id);
    } else {
      await svc.from(prefix + "_sync_state").insert({ tenant_id: tenantId, entity, ...patch });
    }
    await closeSyncRun(svc, prefix, runId, {
      status: errored > 0 ? "partial" : "ok",
      rows_pulled: pulled, rows_inserted: inserted, rows_updated: updated,
      rows_errored: errored, high_water_after: highWater,
    });
    return { entity, pulled, inserted, updated, errored, high_water: highWater };
  } catch (err) {
    const errStr = (err.message || String(err)).slice(0, 800);
    await svc.from(prefix + "_sync_state")
      .upsert({ tenant_id: tenantId, entity, status: "error", error: errStr.slice(0, 500), updated_at: new Date().toISOString() },
              { onConflict: "tenant_id,entity" });
    await closeSyncRun(svc, prefix, runId, { status: "error", error: errStr });
    return { entity, error: errStr };
  }
};
