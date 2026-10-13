// POST /api/orders/terms_check   body: { order_id, include_shadow? }
//
// Re-run the terms check on one order ("Re-check terms" in the Terms tab,
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md 5.4). The same check runs on its own at
// the end of the server-side quote reconcile.
//
// The mode decides what happens:
//   off     nothing is run or written: { mode: "off", ran: "off" }.
//   shadow  the check runs and is stored. The response carries the flags
//           only for an admin who passes include_shadow, as GET does.
//   on      the check runs, is stored, and the response carries it.
//
// A re-run that finds what the current check already holds writes nothing
// (ran: "unchanged").
//
// Before migration 250 is applied: 409 MIGRATION_NOT_APPLIED, naming
// 250_order_terms.sql.
//
// Gated on write (an engineer re-checks), tenant-scoped.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  readTermsSettings, readTermsView, runTermsCheck, migrationErrorBody,
} from "../_lib/terms/check.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const body = (await readBody(req)) || {};
    const orderId = String(body.order_id || "");
    if (!UUID_RE.test(orderId)) return json(res, 400, { error: { message: "order_id must be an order id" } });
    const includeShadow = body.include_shadow === true || body.include_shadow === "1";
    if (includeShadow && !hasPermission(ctx, "admin")) {
      return json(res, 403, { error: { code: "SHADOW_ADMIN_ONLY", message: "Only an admin may read a shadow-mode terms check." } });
    }
    const svc = serviceClient();
    const settings = await readTermsSettings(svc, ctx.tenantId);
    const run = await runTermsCheck(svc, ctx, orderId, { trigger: "manual", settings });
    if (run.status === "not_found") return json(res, 404, { error: { message: "Order not found" } });
    if (run.status === "checked") {
      // Ids and counts only: no clause wording in the audit trail. In shadow
      // mode not even the counts, because the order's timeline shows audit
      // rows to engineers, and shadow flags are hidden from them.
      await recordAudit(ctx, {
        action: "order_terms_checked", objectType: "order", objectId: orderId,
        detail: run.mode === "on"
          ? { check_id: run.check.id, mode: run.mode, po_terms_status: run.check.po_terms_status, flags: run.flags.length }
          : { check_id: run.check.id, mode: run.mode },
      });
    }
    const view = await readTermsView(svc, ctx, orderId, { includeShadow, settings });
    if (view.status === "not_found") return json(res, 404, { error: { message: "Order not found" } });
    return json(res, 200, { ran: run.status, ...view.view });
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return json(res, 409, migrationErrorBody(err));
    sendError(res, err);
  }
}
