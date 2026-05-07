import { serviceClient } from "./supabase.js";

// Audit P1.7 (May 2026). recordAudit() and recordEvent() used to
// await the Supabase insert and discard the result. Supabase
// returns { data, error } rather than throwing, so a failed insert
// (constraint violation, RLS rejection, transient connectivity
// blip) silently vanished. The user-visible action proceeded; only
// the audit record disappeared.
//
// New behaviour:
//   1. console.error on any audit-write failure with structured
//      detail so the log scraper can flag it.
//   2. Best-effort insert into the `audit_failures` sentinel table
//      (migration 063) so on-call has a queryable surface and can
//      reconstruct what was meant to be audited.
//   3. Do NOT throw to the caller. A throw here would break
//      legitimate operations when the audit table is briefly
//      unavailable, and would re-introduce a different denial-of-
//      service vector. The right escalation is a real on-call
//      alarm fed by audit_failures growth, not a throw.
//
// The audit_failures insert intentionally avoids any of the
// columns that fail on the parent table (no foreign keys, no RLS,
// no enum checks), so an audit-events failure does not also cause
// an audit_failures failure.
const recordSentinel = async (svc, table, payload, error) => {
  try {
    await svc.from("audit_failures").insert({
      tenant_id: payload.tenant_id || null,
      table_name: table,
      attempted_action: payload.action || payload.event_type || null,
      attempted_object_type: payload.object_type || null,
      attempted_object_id: payload.object_id ? String(payload.object_id).slice(0, 200) : null,
      error_message: (error && (error.message || String(error))).slice(0, 500),
      error_code: error && error.code ? String(error.code).slice(0, 60) : null,
      raw_payload: payload,
    });
  } catch (sentinelErr) {
    // Last-line fallback: stderr only. We deliberately do NOT
    // throw here. If audit_failures is also broken, we still
    // shouldn't kill the user-visible action; the operator team
    // sees the console.error and intervenes.
    // eslint-disable-next-line no-console
    console.error("[audit] sentinel write failed", {
      table,
      action: payload.action || payload.event_type,
      original_error: error && error.message,
      sentinel_error: sentinelErr && sentinelErr.message,
    });
  }
};

export const recordAudit = async (ctx, payload) => {
  if (!ctx || !ctx.tenantId) {
    // eslint-disable-next-line no-console
    console.warn("[audit] recordAudit called without ctx.tenantId; dropping " + (payload && payload.action));
    return;
  }
  const svc = serviceClient();
  const row = {
    tenant_id: ctx.tenantId,
    actor: ctx.user ? ctx.user.id : null,
    actor_role: ctx.role || null,
    action: payload.action,
    object_type: payload.objectType || "system",
    object_id: payload.objectId || null,
    before_payload: payload.before || null,
    after_payload: payload.after || null,
    payload_hash: payload.payloadHash || null,
    source_evidence_ids: payload.evidenceIds || null,
    reason: payload.reason || null,
    detail: payload.detail || null,
  };
  const { error } = await svc.from("audit_events").insert(row);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[audit] audit_events insert failed", {
      tenant_id: ctx.tenantId,
      action: payload.action,
      object_type: row.object_type,
      object_id: row.object_id,
      error_code: error.code,
      error_message: error.message,
    });
    await recordSentinel(svc, "audit_events", row, error);
  }
};

export const recordEvent = async (ctx, payload) => {
  if (!ctx || !ctx.tenantId) {
    // eslint-disable-next-line no-console
    console.warn("[audit] recordEvent called without ctx.tenantId; dropping " + (payload && payload.eventType));
    return;
  }
  const svc = serviceClient();
  const row = {
    tenant_id: ctx.tenantId,
    case_id: payload.caseId,
    event_type: payload.eventType,
    object_type: payload.objectType,
    object_id: payload.objectId || null,
    detail: payload.detail || {},
    duration_ms: payload.durationMs || null,
  };
  const { error } = await svc.from("processing_events").insert(row);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[audit] processing_events insert failed", {
      tenant_id: ctx.tenantId,
      event_type: payload.eventType,
      case_id: row.case_id,
      error_code: error.code,
      error_message: error.message,
    });
    await recordSentinel(svc, "processing_events", row, error);
  }
};
