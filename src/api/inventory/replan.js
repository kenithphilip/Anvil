// POST /api/inventory/replan
// Body: {} (empty)
//
// Force a replan run for the caller's tenant. Same engine as the
// weekly cron, but admin-gated and synchronous so the operator
// can click "Run replan now" from the dashboard and watch the
// new plans appear.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { planTenant } from "../cron/inventory-planning-weekly.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();
    const result = await planTenant(svc, ctx.tenantId);
    // Phase 3.5: doc 7.10 specifies `inventory.replan.forced` for
    // operator-triggered replans (vs. the cron's
    // `inventory.replan.cron_completed`).
    await recordAudit(ctx, {
      action: "inventory.replan.forced",
      objectType: "forecast_run",
      objectId: result?.run_id || null,
      detail: {
        items_planned: result?.items_planned || 0,
        plans_created: result?.plans_created || 0,
      },
    });
    return json(res, 200, { ok: true, result });
  } catch (err) { sendError(res, err); }
}
