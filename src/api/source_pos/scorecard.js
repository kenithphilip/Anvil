// GET /api/source_pos/scorecard?supplier=&country=
// Returns supplier scorecards with on-time, price accuracy, response time aggregates.

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
    const svc = serviceClient();
    let q = svc.from("supplier_scorecards").select("*").eq("tenant_id", ctx.tenantId).order("on_time_pct", { ascending: false }).limit(200);
    if (req.query.supplier) q = q.eq("supplier", req.query.supplier);
    if (req.query.country) q = q.eq("country", req.query.country);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return json(res, 200, { scorecards: data });
  } catch (err) {
    sendError(res, err);
  }
}
