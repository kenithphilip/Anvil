// POST or GET /api/analytics/refresh
//
// Cron-only via Bearer CRON_SECRET (drains every tenant) plus a
// manual admin trigger (recomputes for the caller's tenant).
// Recomputes the last 90 days of analytics_winloss_daily +
// analytics_customer_monthly. Idempotent (upsert by unique key).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { refreshWinloss } from "../_lib/winloss.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const tenants = await svc.from("tenants").select("id");
      if (tenants.error) throw new Error("tenants: " + tenants.error.message);
      const out = [];
      for (const t of tenants.data || []) {
        out.push(await refreshWinloss(svc, t.id, { sinceDays: 90 }));
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = req.method === "POST" ? await readBody(req) : {};
    const sinceDays = Math.min(365, Math.max(7, Number(body?.since_days || 90)));
    const out = await refreshWinloss(svc, ctx.tenantId, { sinceDays });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
