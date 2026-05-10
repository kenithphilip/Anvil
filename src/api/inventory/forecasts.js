// GET /api/inventory/forecasts
// Query: ?part_no=ATD-STD-1&horizon_weeks=12
//
// Returns the demand_forecasts rows for the item over the next N
// weeks, with the decomposition (committed / pipeline / baseline)
// and the predictive distribution quantiles for the chart.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://_");
    const partNo = url.searchParams.get("part_no");
    const horizon = Math.min(52, Math.max(1, Number(url.searchParams.get("horizon_weeks") || 12)));
    const svc = serviceClient();
    let q = svc.from("demand_forecasts").select("*")
      .eq("tenant_id", ctx.tenantId)
      .gte("week_start", new Date().toISOString().slice(0, 10))
      .order("week_start", { ascending: true });
    if (partNo) q = q.eq("part_no", partNo);
    q = q.limit(horizon * 50);   // cap the row count
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return json(res, 200, { forecasts: data || [] });
  } catch (err) { sendError(res, err); }
}
