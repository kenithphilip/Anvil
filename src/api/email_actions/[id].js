// /api/email_actions/<id>: one email action.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.5, 6.8 and 6.10.
//
//   GET    the action, and its history (audit_events).
//   PATCH  { version, ...one or more changes }:
//            status            a move from store.TRANSITIONS. "performed" needs
//                              evidence (EA-5); cancel and reopen need a reason.
//            assignee_user_id  the owner may hand off; anyone else needs
//                              email.reassign. Must be an approved member.
//            backup_user_id    an approved member, or null.
//            priority          1-4 or a label, with a reason (a correction).
//            action_type       with a reason (a correction); the requirement
//                              follows the type.
//            business_status   the business outcome. The verifier never sets
//                              resolved or closed; a person does, here.
//            due_at            a manual due time, with a reason.
//          version is work_items.version; a stale one is 409.
//
// Every change writes audit_events with the before and after values.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { resolveAssignee } from "../_lib/assignee.js";
import { loadAction } from "../_lib/email-accountability/access.js";
import { TRANSITIONS, STATUS_CATEGORY, isReopen } from "../_lib/email-accountability/store.js";
import { ACTION_TYPES, REQUIREMENT_BY_TYPE, PRIORITY_RANK } from "../_lib/email-accountability/rules.js";

const BUSINESS = ["not_assessed", "awaiting_internal", "awaiting_external", "in_progress", "resolved", "closed"];
const bad = (res, status, message) => json(res, status, { error: { message } });
const reasonOf = (b) => (typeof b.reason === "string" && b.reason.trim().length >= 3 ? b.reason.trim().slice(0, 500) : null);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const id = String(req.query?.id || "");
    const found = id ? await loadAction(svc, ctx, id) : null;
    if (!found) return bad(res, 404, "email action not found");
    const { ea, wi } = found;

    if (req.method === "GET") {
      const h = await svc.from("audit_events").select("action, actor, actor_role, before_payload, after_payload, reason, created_at")
        .eq("tenant_id", ctx.tenantId).eq("object_type", "email_action").eq("object_id", id)
        .order("created_at", { ascending: true });
      if (h.error) throw new Error("history: " + h.error.message);
      return json(res, 200, { ok: true, action: found.row, history: h.data || [] });
    }
    if (req.method !== "PATCH") return bad(res, 405, "method not allowed");

    const b = (await readBody(req)) || {};
    if (Number(b.version) !== Number(wi.version)) return bad(res, 409, "the action changed since you loaded it; reload and try again");
    const reason = reasonOf(b);
    const now = new Date().toISOString();
    const work = {};
    const email = {};
    const audits = [];

    if (b.status !== undefined) {
      const to = String(b.status);
      if (to === "performed") return bad(res, 409, "an action is performed only with evidence; record evidence instead");
      if (!(TRANSITIONS[wi.status] || []).includes(to)) return bad(res, 409, "cannot move from " + wi.status + " to " + to);
      const reopen = isReopen(wi.status, to);
      if ((to === "cancelled" || reopen) && !reason) return bad(res, 400, "a reason is required to " + (reopen ? "reopen" : "cancel"));
      Object.assign(work, { status: to, status_category: STATUS_CATEGORY[to] });
      if (to === "cancelled") Object.assign(work, { completed_at: now, completed_by: ctx.user.id, resolution: "cancelled" });
      if (reopen) {
        Object.assign(work, { completed_at: null, completed_by: null, resolution: null });
        Object.assign(email, { reopen_count: (ea.reopen_count || 0) + 1, escalation_level: 0 });
      }
      if (wi.status === "awaiting_review" && to === "pending" && ea.business_status === "not_assessed") email.business_status = "awaiting_internal";
      if (to === "pending" && !wi.assignee_user_id && b.assignee_user_id === undefined) work.assignee_user_id = ctx.user.id;
      audits.push({ action: reopen ? "email_action_reopened" : "email_action_status", before: { status: wi.status }, after: { status: to } });
    }

    if (b.assignee_user_id !== undefined) {
      const isOwner = wi.assignee_user_id === ctx.user.id;
      if (!isOwner && wi.assignee_user_id && !hasAction(ctx, "email.reassign")) return bad(res, 403, "only the owner or a manager can reassign this action");
      const to = b.assignee_user_id ? await resolveAssignee(svc, ctx.tenantId, String(b.assignee_user_id)) : null;
      if (b.assignee_user_id && !to) return bad(res, 400, "the new owner is not an approved member of this tenant");
      if (!to && !hasAction(ctx, "email.reassign")) return bad(res, 403, "only a manager can leave an action without an owner");
      work.assignee_user_id = to;
      if ((work.status || wi.status) === "detected" && to) Object.assign(work, { status: "pending", status_category: "todo" });
      audits.push({ action: "email_action_reassigned", before: { assignee_user_id: wi.assignee_user_id }, after: { assignee_user_id: to } });
    }

    if (b.backup_user_id !== undefined) {
      const to = b.backup_user_id ? await resolveAssignee(svc, ctx.tenantId, String(b.backup_user_id)) : null;
      if (b.backup_user_id && !to) return bad(res, 400, "the backup is not an approved member of this tenant");
      email.backup_user_id = to;
      audits.push({ action: "email_action_backup", before: { backup_user_id: ea.backup_user_id }, after: { backup_user_id: to } });
    }

    if (b.priority !== undefined) {
      const p = Number(PRIORITY_RANK[b.priority] || b.priority);
      if (![1, 2, 3, 4].includes(p)) return bad(res, 400, "priority must be 1-4 or critical, high, normal, informational");
      if (!reason) return bad(res, 400, "a reason is required to correct the priority");
      work.priority = p;
      audits.push({ action: "email_action_corrected", before: { priority: wi.priority }, after: { priority: p } });
    }

    if (b.action_type !== undefined) {
      if (!ACTION_TYPES.includes(b.action_type)) return bad(res, 400, "action_type must be one of " + ACTION_TYPES.join(", "));
      if (!reason) return bad(res, 400, "a reason is required to correct the action type");
      Object.assign(email, { action_type: b.action_type, requirement: REQUIREMENT_BY_TYPE[b.action_type] });
      audits.push({ action: "email_action_corrected", before: { action_type: ea.action_type }, after: { action_type: b.action_type } });
    }

    if (b.business_status !== undefined) {
      if (!BUSINESS.includes(b.business_status)) return bad(res, 400, "business_status must be one of " + BUSINESS.join(", "));
      email.business_status = b.business_status;
      audits.push({ action: "email_action_business_status", before: { business_status: ea.business_status }, after: { business_status: b.business_status } });
    }

    if (b.due_at !== undefined) {
      const t = Date.parse(b.due_at);
      if (!Number.isFinite(t)) return bad(res, 400, "due_at must be a date and time");
      if (!reason) return bad(res, 400, "a reason is required to change the due time");
      Object.assign(work, { due_at: new Date(t).toISOString(), due_source: "manual", due_basis: { set_by: ctx.user.id } });
      audits.push({ action: "email_action_due_changed", before: { due_at: wi.due_at }, after: { due_at: new Date(t).toISOString() } });
    }

    if (!audits.length) return bad(res, 400, "nothing to change");

    // The email side first: a stale version after it leaves at most a counter
    // moved, never a state change without its audit.
    if (Object.keys(email).length) {
      const e = await svc.from("email_actions").update({ ...email, updated_at: now }).eq("tenant_id", ctx.tenantId).eq("id", ea.id);
      if (e.error) {
        if (e.error.code === "23505") return bad(res, 409, "this message already has an action of that type");
        throw new Error("action update: " + e.error.message);
      }
    }
    const w = await svc.from("work_items").update({ ...work, updated_at: now, version: wi.version + 1 })
      .eq("tenant_id", ctx.tenantId).eq("id", wi.id).eq("version", wi.version).select("id");
    if (w.error) throw new Error("work item update: " + w.error.message);
    if (!w.data?.length) return bad(res, 409, "the action changed since you loaded it; reload and try again");

    for (const a of audits) await recordAudit(ctx, { ...a, objectType: "email_action", objectId: ea.id, reason });
    const after = await loadAction(svc, ctx, id);
    return json(res, 200, { ok: true, action: after ? after.row : null });
  } catch (err) {
    return sendError(res, err);
  }
}
