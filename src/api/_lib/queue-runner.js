// Generic queue-drain helper for the inbound-pipeline workers
// introduced in Phase 2 of the audit roadmap.
//
// The codebase had four "producer-without-consumer" queues that
// each followed the same shape: a webhook persisted a row into a
// table with a status (or completed flag) field, and a comment
// promised a downstream worker that did not exist:
//
//   1. inbound_emails (status='linked')         no consumer
//   2. voice_call_actions (completed=false)     no consumer
//   3. inbound_messages (status='arrived')      no consumer
//   4. documents (scan_status='clean' from inbound) no consumer
//
// Rather than re-implementing the same drain loop four times this
// helper factors the shape so each worker only has to define what
// "process one row" means and how to mark a row as done or failed.
//
// Contract:
//
//   const out = await drainQueue(svc, {
//     table: 'inbound_emails',
//     selectColumns: 'id, tenant_id, ...',
//     statusColumn: 'status',
//     statusValue: 'linked',
//     limit: 25,
//     // batchOrder defaults to created_at ascending; pass a column
//     // name + direction to override.
//     batchOrder: { column: 'received_at', ascending: true },
//     // Per-row processor. Returns one of:
//     //   { ok: true, patch: { status: 'archived', linked_order_id: ... } }
//     //   { ok: false, error: 'reason' }   -> row is marked failed
//     processFn,
//   });
//
// The helper writes the result as a patch on the source row, then
// returns a summary `{ processed, succeeded, failed, results: [] }`.
// Errors thrown inside processFn are caught and surfaced as
// `{ ok: false, error: err.message }` so a single bad row does not
// abort the batch.

export const drainQueue = async (svc, opts) => {
  const {
    table,
    selectColumns = "*",
    statusColumn = "status",
    statusValue,
    completedColumn = null,
    completedValue = false,
    limit = 25,
    batchOrder = { column: "created_at", ascending: true },
    processFn,
    failedStatusValue = "failed",
    errorColumn = "error",
  } = opts || {};

  if (!table || !processFn) {
    throw new Error("drainQueue requires table + processFn");
  }

  // Pick rows. We use either a status-column match or a
  // completed-flag match depending on the queue's shape.
  let q = svc.from(table).select(selectColumns);
  if (completedColumn) {
    q = q.eq(completedColumn, completedValue);
  } else {
    q = q.eq(statusColumn, statusValue);
  }
  q = q.order(batchOrder.column, { ascending: batchOrder.ascending !== false }).limit(limit);
  const rows = await q;
  if (rows.error) throw new Error(table + " read: " + rows.error.message);

  const results = [];
  for (const row of rows.data || []) {
    let outcome;
    try {
      outcome = await processFn(row);
    } catch (err) {
      outcome = { ok: false, error: err && (err.message || String(err)) };
    }
    if (outcome && outcome.ok && outcome.patch) {
      const upd = await svc.from(table).update(outcome.patch).eq("id", row.id);
      if (upd.error) {
        results.push({ id: row.id, status: "patch_failed", error: upd.error.message });
        continue;
      }
      results.push({ id: row.id, status: "ok", patch: outcome.patch });
    } else if (outcome && outcome.ok) {
      // ok with no patch is allowed (e.g., the processor itself
      // updated the row).
      results.push({ id: row.id, status: "ok" });
    } else {
      const errMsg = (outcome && outcome.error) || "unknown";
      const failPatch = {};
      if (completedColumn) {
        // For completed-flag queues we still flip a flag and record
        // the error in the dedicated `error` column.
        failPatch[completedColumn] = true;
        if (errorColumn) failPatch[errorColumn] = String(errMsg).slice(0, 800);
      } else {
        failPatch[statusColumn] = failedStatusValue;
        if (errorColumn) failPatch[errorColumn] = String(errMsg).slice(0, 800);
      }
      const upd = await svc.from(table).update(failPatch).eq("id", row.id);
      results.push({
        id: row.id,
        status: "failed",
        error: String(errMsg).slice(0, 200),
        patch_persisted: !upd.error,
      });
    }
  }

  return {
    table,
    considered: (rows.data || []).length,
    succeeded: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "patch_failed").length,
    results,
  };
};
