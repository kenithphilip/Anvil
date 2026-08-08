// GET /api/analytics/otd?window_days=180
//
// Customer on-time-delivery rollup (Logistics Ops P3). On-time % over orders
// that carried a committed_delivery_date and have a delivered shipment, plus the
// count still open against a commitment. Distinct from every other "OTD" in the
// codebase, which measures on-time PAYMENT or supplier ack. Read-only.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computeOtd } from "../_lib/logistics/otd.js";

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

    const windowDays = Math.max(1, Math.min(730, Number(req.query?.window_days) || 180));
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);

    const [ordRes, shRes] = await Promise.all([
      svc.from("orders")
        .select("id, po_number, committed_delivery_date")
        .eq("tenant_id", ctx.tenantId)
        .not("committed_delivery_date", "is", null)
        .gte("committed_delivery_date", since)
        .limit(2000),
      svc.from("shipments")
        .select("order_id, customer_delivery_date, status")
        .eq("tenant_id", ctx.tenantId)
        .in("status", ["DELIVERED", "POD_RECEIVED"])
        .limit(4000),
    ]);
    if (ordRes.error) throw new Error("orders: " + ordRes.error.message);
    if (shRes.error) throw new Error("shipments: " + shRes.error.message);

    const rollup = computeOtd(ordRes.data || [], shRes.data || []);
    return json(res, 200, { window_days: windowDays, ...rollup });
  } catch (err) {
    sendError(res, err);
  }
}
