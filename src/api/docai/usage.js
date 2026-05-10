// GET /api/docai/usage?date=YYYY-MM-DD
//
// Surfaces today's docai_daily_usage counters for the calling
// tenant so the operator can see how close they are to any
// configured docai_daily_limits cap. Default date = today; the
// `date` query param lets admin tools backfill / inspect history.
//
// Response:
//   {
//     date: "2026-05-10",
//     limits: { adapter: int, ... } | null,
//     usage:  [{ adapter, call_count, estimated_cost_usd, last_called_at, limit, remaining }]
//   }

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { summariseUsage } from "../_lib/cost_guard.js";

const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    const date = (req.query?.date || today()).toString();
    const usage = await summariseUsage(svc, { tenantId: ctx.tenantId, date });
    const limits = settings?.docai_daily_limits || null;
    const decorated = usage.map((u) => {
      const limit = limits?.[u.adapter];
      const limitNum = Number.isFinite(Number(limit)) ? Number(limit) : null;
      const remaining = limitNum != null
        ? Math.max(0, limitNum - Number(u.call_count || 0))
        : null;
      return {
        adapter: u.adapter,
        call_count: Number(u.call_count || 0),
        estimated_cost_usd: Number(u.estimated_cost_usd || 0),
        last_called_at: u.last_called_at,
        limit: limitNum,
        remaining,
      };
    });
    return json(res, 200, { date, limits, usage: decorated });
  } catch (err) { sendError(res, err); }
}
