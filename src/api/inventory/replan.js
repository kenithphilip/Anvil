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
    return json(res, 200, { ok: true, result });
  } catch (err) { sendError(res, err); }
}
