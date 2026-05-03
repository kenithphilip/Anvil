import { serviceClient } from "./supabase.js";

export const recordAudit = async (ctx, payload) => {
  if (!ctx || !ctx.tenantId) return;
  const svc = serviceClient();
  await svc.from("audit_events").insert({
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
  });
};

export const recordEvent = async (ctx, payload) => {
  if (!ctx || !ctx.tenantId) return;
  const svc = serviceClient();
  await svc.from("processing_events").insert({
    tenant_id: ctx.tenantId,
    case_id: payload.caseId,
    event_type: payload.eventType,
    object_type: payload.objectType,
    object_id: payload.objectId || null,
    detail: payload.detail || {},
    duration_ms: payload.durationMs || null,
  });
};
