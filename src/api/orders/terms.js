// GET /api/orders/terms?order_id=<uuid>[&include_shadow=1]
//
// The terms check of one order: the current check, and each flag with the PO
// wording and the quote wording side by side, each labelled with where it
// came from (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 3.3 and 6.6).
//
// The tenant's mode decides what is shown:
//   off     nothing (visible: false), whatever older checks hold.
//   shadow  nothing, unless an admin passes include_shadow=1. Shadow mode
//           measures precision before anyone acts on a flag, so the screen
//           hides it from engineers. A non-admin asking is refused.
//   on      the check and its flags.
//
// Before migration 250 is applied: 409 MIGRATION_NOT_APPLIED, naming
// 250_order_terms.sql.
//
// Read-only and tenant-scoped (read, like the order itself).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { readTermsView, migrationErrorBody } from "../_lib/terms/check.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const wantsShadow = (query) => query?.include_shadow === "1" || query?.include_shadow === "true";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    // Fail closed: without a tenant there is nothing this caller may see.
    if (!ctx || !ctx.tenantId) return json(res, 403, { error: { message: "No tenant in context" } });
    const orderId = String(req.query?.order_id || "");
    if (!UUID_RE.test(orderId)) return json(res, 400, { error: { message: "order_id must be an order id" } });
    const includeShadow = wantsShadow(req.query);
    if (includeShadow && !hasPermission(ctx, "admin")) {
      return json(res, 403, { error: { code: "SHADOW_ADMIN_ONLY", message: "Only an admin may read a shadow-mode terms check." } });
    }
    const out = await readTermsView(serviceClient(), ctx, orderId, { includeShadow });
    if (out.status === "not_found") return json(res, 404, { error: { message: "Order not found" } });
    return json(res, 200, out.view);
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return json(res, 409, migrationErrorBody(err));
    sendError(res, err);
  }
}
