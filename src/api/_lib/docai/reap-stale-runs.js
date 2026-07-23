// Reaper for extraction runs stranded at status='running'.
//
// run.js inserts the row as 'running' and only writes the terminal status in
// its FINAL update. So when the serverless function is killed mid-flight — the
// platform's hard ceiling is 60s on the current plan — the row is never
// finalised: no attempts, no error, no finished_at. It stays 'running' for
// ever, the workspace shows a permanent spinner, and nothing ever tells the
// operator the work died. Two runs on PO 0066026562 were stuck exactly this
// way.
//
// The run budget in run.js is the primary defence (stop dispatching before the
// ceiling). This is the backstop for the cases it cannot cover: a hard kill, a
// crash between the insert and the final update, a deploy mid-run.
//
// Deliberately conservative: only rows older than the cutoff are touched, so a
// legitimately in-flight run is never reaped. The cutoff must exceed the
// function ceiling.

const DEFAULT_STALE_MINUTES = 5;

// Mark stale 'running' extraction_runs as failed. Scoped to one tenant when
// tenantId is given (the diagnostics read path), else swept across all
// tenants (the cron). Returns { reaped, ids }. Best-effort: never throws, so
// a caller in a read path or a cron group is never broken by it.
export const reapStaleRuns = async (svc, { tenantId = null, staleMinutes = DEFAULT_STALE_MINUTES } = {}) => {
  const out = { reaped: 0, ids: [] };
  if (!svc) return out;
  const minutes = Math.max(2, Number(staleMinutes) || DEFAULT_STALE_MINUTES);
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  try {
    let q = svc.from("extraction_runs")
      .update({
        status: "failed",
        status_reason: "timed_out",
        finished_at: new Date().toISOString(),
        error: "Run exceeded the serverless function ceiling and was killed before it could finish. "
          + "The provider call may still have been billed. Re-run extraction; if it recurs, the document "
          + "needs the background path rather than a synchronous run.",
      })
      .eq("status", "running")
      .lt("started_at", cutoff);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const r = await q.select("id");
    if (r.error) return out;
    out.ids = (r.data || []).map((x) => x.id);
    out.reaped = out.ids.length;
  } catch (_e) { /* best-effort */ }
  return out;
};

export const __consts__ = { DEFAULT_STALE_MINUTES };
