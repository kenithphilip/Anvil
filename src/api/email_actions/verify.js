// POST /api/email_actions/<id>/verify: a person decides one piece of evidence
// that is not settled: a manual claim, or ambiguous mail.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.6 and decision ED-4.
//
//   body { evidence_id, decision: "confirm" | "reject", reason }
//
// Needs email.verify. The claimant never confirms their own claim (maker and
// checker). confirm: the action is performed, and the business outcome moves
// from awaiting_internal to awaiting_external (never to resolved). reject: the
// evidence is rejected, and an action that waited only for it goes back to
// in_progress. Both are audited with the reason.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { loadAction } from "../_lib/email-accountability/access.js";
import { STATUS_CATEGORY, OPEN_CATEGORIES } from "../_lib/email-accountability/store.js";

const OPEN_EVIDENCE = ["claimed", "ambiguous"];
const bad = (res, status, message) => json(res, status, { error: { message } });

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") return bad(res, 405, "method not allowed");
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    requireAction(ctx, "email.verify");
    const svc = serviceClient();
    const id = String(req.query?.id || "");
    const found = id ? await loadAction(svc, ctx, id) : null;
    if (!found) return bad(res, 404, "email action not found");
    const { ea, wi } = found;

    const b = (await readBody(req)) || {};
    if (!["confirm", "reject"].includes(b.decision)) return bad(res, 400, "decision must be confirm or reject");
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 3) return bad(res, 400, "a reason is required");

    const ev = await svc.from("email_action_evidence").select("*")
      .eq("tenant_id", ctx.tenantId).eq("email_action_id", ea.id).eq("id", String(b.evidence_id || "")).maybeSingle();
    if (ev.error) throw new Error("evidence read: " + ev.error.message);
    if (!ev.data) return bad(res, 404, "evidence not found");
    if (!OPEN_EVIDENCE.includes(ev.data.status)) return bad(res, 409, "this evidence is already " + ev.data.status);
    if (ev.data.kind === "manual" && ev.data.recorded_by === ctx.user.id) {
      return bad(res, 403, "the person who made a claim cannot confirm or reject it");
    }
    if (b.decision === "confirm" && !OPEN_CATEGORIES.includes(wi.status_category)) {
      return bad(res, 409, "the action is " + wi.status + "; reopen it first");
    }

    const now = new Date().toISOString();
    const decided = await svc.from("email_action_evidence").update({
      status: b.decision === "confirm" ? "confirmed" : "rejected",
      decided_by: ctx.user.id, decided_at: now, decision_reason: reason.slice(0, 500),
    }).eq("tenant_id", ctx.tenantId).eq("id", ev.data.id).in("status", OPEN_EVIDENCE).select("id");
    if (decided.error) throw new Error("evidence update: " + decided.error.message);
    if (!decided.data?.length) return bad(res, 409, "someone decided this evidence a moment ago; reload");

    let to = null;
    if (b.decision === "confirm") {
      to = "performed";
    } else if (wi.status === "awaiting_verification") {
      const rest = await svc.from("email_action_evidence").select("id")
        .eq("tenant_id", ctx.tenantId).eq("email_action_id", ea.id).in("status", OPEN_EVIDENCE).limit(1);
      if (rest.error) throw new Error("evidence read: " + rest.error.message);
      if (!(rest.data || []).length) to = "in_progress";
    }
    if (to) {
      const patch = { status: to, status_category: STATUS_CATEGORY[to], version: wi.version + 1, updated_at: now };
      if (to === "performed") {
        Object.assign(patch, {
          completed_at: now, completed_by: ctx.user.id,
          resolution: ev.data.kind === "manual" ? "manual_override" : "verified_by_person",
        });
      }
      const w = await svc.from("work_items").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", wi.id).eq("version", wi.version).select("id");
      if (w.error) throw new Error("work item update: " + w.error.message);
      if (!w.data?.length) return bad(res, 409, "the action changed since you loaded it; reload and try again");
      if (to === "performed" && ["awaiting_internal", "not_assessed"].includes(ea.business_status)) {
        const e = await svc.from("email_actions").update({ business_status: "awaiting_external", updated_at: now })
          .eq("tenant_id", ctx.tenantId).eq("id", ea.id);
        if (e.error) throw new Error("business status: " + e.error.message);
      }
    }
    await recordAudit(ctx, {
      action: b.decision === "confirm" ? "email_action_manual_verified" : "email_action_evidence_rejected",
      objectType: "email_action", objectId: ea.id,
      before: { status: wi.status, evidence_status: ev.data.status },
      after: { status: to || wi.status, evidence_id: ev.data.id, evidence_status: b.decision === "confirm" ? "confirmed" : "rejected" },
      reason,
    });
    const after = await loadAction(svc, ctx, id);
    return json(res, 200, { ok: true, action: after ? after.row : null });
  } catch (err) {
    return sendError(res, err);
  }
}
