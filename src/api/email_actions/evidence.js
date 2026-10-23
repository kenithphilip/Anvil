// POST /api/email_actions/<id>/evidence: a person's claim that the action was
// done outside the mail Anvil can see (a call, a chat, another mailbox).
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.6 (manual path) and decision ED-4.
//
//   body { note (at least 10 characters), reference? }
//
// The claim never completes the action. It moves it to awaiting_verification,
// and a user with email.verify who is not the claimant confirms or rejects it
// (POST /api/email_actions/<id>/verify). Audited.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { loadAction } from "../_lib/email-accountability/access.js";
import { STATUS_CATEGORY } from "../_lib/email-accountability/store.js";

const CLAIM_FROM = ["detected", "awaiting_review", "pending", "in_progress", "awaiting_verification"];
const bad = (res, status, message) => json(res, status, { error: { message } });

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") return bad(res, 405, "method not allowed");
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const id = String(req.query?.id || "");
    const found = id ? await loadAction(svc, ctx, id) : null;
    if (!found) return bad(res, 404, "email action not found");
    const { ea, wi } = found;
    if (!CLAIM_FROM.includes(wi.status)) return bad(res, 409, "the action is " + wi.status + "; reopen it first");

    const b = (await readBody(req)) || {};
    const note = typeof b.note === "string" ? b.note.trim() : "";
    if (note.length < 10) return bad(res, 400, "say what was done, in at least 10 characters");
    const reference = b.reference ? String(b.reference).trim().slice(0, 300) : null;

    const ins = await svc.from("email_action_evidence").insert({
      tenant_id: ctx.tenantId, email_action_id: ea.id, kind: "manual", method: "manual",
      status: "claimed", confidence: null, note: note.slice(0, 1000), reference, recorded_by: ctx.user.id,
      reasons: [{ kind: "fact", code: "manual_claim", text: "A person says the action was done." }],
    }).select("id");
    if (ins.error) throw new Error("evidence insert: " + ins.error.message);
    const evidenceId = ins.data?.[0]?.id || null;

    if (wi.status !== "awaiting_verification") {
      const w = await svc.from("work_items").update({
        status: "awaiting_verification", status_category: STATUS_CATEGORY.awaiting_verification,
        version: wi.version + 1, updated_at: new Date().toISOString(),
      }).eq("tenant_id", ctx.tenantId).eq("id", wi.id).eq("version", wi.version).select("id");
      if (w.error) throw new Error("work item update: " + w.error.message);
      if (!w.data?.length) return bad(res, 409, "the action changed since you loaded it; reload and try again");
    }
    await recordAudit(ctx, {
      action: "email_action_evidence_claimed", objectType: "email_action", objectId: ea.id,
      before: { status: wi.status }, after: { status: "awaiting_verification", evidence_id: evidenceId },
      reason: note.slice(0, 500),
    });
    const after = await loadAction(svc, ctx, id);
    return json(res, 200, { ok: true, evidence_id: evidenceId, action: after ? after.row : null });
  } catch (err) {
    return sendError(res, err);
  }
}
