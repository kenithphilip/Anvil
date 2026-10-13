// POST /api/orders/terms_decide
//   body: { order_id, flag_id, decision, reason }
//
// Record the engineer's decision on one terms flag
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 6). Append-only: every call
// inserts one order_term_decisions row and never updates or deletes one. A
// changed mind is a new row; the newest row per flag is the current
// decision, and the history keeps them all.
//
//   decision  accept | request_amendment | reject_term | not_a_deviation
//   reason    required, at least MIN_REASON_LENGTH characters after trimming
//
// Who may decide (owner decision 2, 2026-10-13), enforced here:
//   - write, then order.terms_decide (sales_engineer, sales_manager, admin);
//   - accept or not_a_deviation on a high or critical flag also needs
//     order.terms_accept_high (sales_manager, admin), as does any accept on
//     a clause whose tenant policy sets accept_requires;
//   - request_amendment and reject_term need only order.terms_decide.
//
// The mode: off refuses (409 TERMS_CHECK_OFF). In shadow only an admin may
// decide, because the flags are hidden from everyone else.
//
// Audit: an order_term_decided audit row and a term_decided timeline event,
// with the flag id, clause, severity and decision. No clause wording and no
// reason text: those stay in the decision row.
//
// Before migration 250 is applied: 409 MIGRATION_NOT_APPLIED, naming
// 250_order_terms.sql.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction, hasAction, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { readTermsSettings, flagView } from "../_lib/terms/check.js";
import { migrationErrorBody, termsDbError } from "../_lib/terms/errors.js";
import {
  DECISIONS, DECIDE_ACTION, MIN_REASON_LENGTH, actionsFor, historyByFlag, nextDecidedAt, readDecisions, validReason,
} from "../_lib/terms/decisions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (res, status, code, message) => json(res, status, { error: { code, message, status } });

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    if (!ctx || !ctx.tenantId) return json(res, 403, { error: { message: "No tenant in context" } });
    requireAction(ctx, DECIDE_ACTION);

    const body = (await readBody(req)) || {};
    const orderId = String(body.order_id || "");
    const flagId = String(body.flag_id || "");
    if (!UUID_RE.test(orderId) || !flagId) return refuse(res, 400, "BAD_REQUEST", "order_id and flag_id are required");
    const decision = String(body.decision || "");
    if (!DECISIONS.includes(decision)) {
      return refuse(res, 400, "BAD_DECISION", "decision must be one of " + DECISIONS.join(", "));
    }
    const reason = validReason(body.reason);
    if (!reason) {
      return refuse(res, 400, "REASON_REQUIRED", "A reason is required: at least " + MIN_REASON_LENGTH + " characters that say why.");
    }

    const svc = serviceClient();
    const tenantId = ctx.tenantId;
    const settings = await readTermsSettings(svc, tenantId);
    if (settings.mode === "off") return refuse(res, 409, "TERMS_CHECK_OFF", "The terms check is off for this tenant.");
    if (settings.mode === "shadow" && !hasPermission(ctx, "admin")) {
      return refuse(res, 403, "TERMS_SHADOW", "The terms check is in shadow mode. Only an admin may decide its flags.");
    }

    const fq = await svc.from("order_term_flags").select("*")
      .eq("tenant_id", tenantId).eq("order_id", orderId).eq("id", flagId).maybeSingle();
    if (fq.error) throw termsDbError("order_term_flags", fq.error);
    const flag = fq.data;
    if (!flag) return json(res, 404, { error: { message: "Terms flag not found" } });
    if (flag.superseded_at) {
      return refuse(res, 409, "FLAG_SUPERSEDED", "A newer terms check replaced this flag. Reload the Terms tab and decide on the current one.");
    }

    const clausePolicy = flag.clause ? settings.policy.clauses[flag.clause] : null;
    for (const action of actionsFor(decision, flag.severity, clausePolicy)) {
      if (!hasAction(ctx, action)) {
        return refuse(res, 403, "ACTION_FORBIDDEN", decision === "accept" || decision === "not_a_deviation"
          ? "Accepting a " + flag.severity + " flag" + (decision === "not_a_deviation" ? ", or calling it not a deviation," : "") + " needs a sales manager or an admin (" + action + "). You may request an amendment or reject the term."
          : "Role " + ctx.role + " is not permitted to perform '" + action + "'");
      }
    }

    const before = await readDecisions(svc, tenantId, [flag.id]);
    const row = {
      tenant_id: tenantId,
      order_id: orderId,
      flag_id: flag.id,
      decision,
      reason,
      decided_by: ctx.user?.id || null,
      decided_role: ctx.role || null,
      decided_at: nextDecidedAt(before),
    };
    const ins = await svc.from("order_term_decisions").insert(row).select("*").single();
    if (ins.error) throw termsDbError("order_term_decisions insert", ins.error);

    const detail = { flag_id: flag.id, clause: flag.clause || null, severity: flag.severity, decision };
    await recordAudit(ctx, { action: "order_term_decided", objectType: "order", objectId: orderId, detail });
    await recordEvent(ctx, { caseId: orderId, eventType: "term_decided", objectType: "order", objectId: orderId, detail });

    const history = historyByFlag([...before, ins.data]).get(flag.id) || [];
    return json(res, 200, { flag: flagView(flag, settings.policy, { history, ctx }) });
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return json(res, 409, migrationErrorBody(err));
    sendError(res, err);
  }
}
