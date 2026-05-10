// GET /api/treds/list
//
// Operator dashboard surface. Returns:
//   - offers grouped by auction_status
//   - settled discounts (status=disbursed | settled)
//   - rollup KPIs (count, total volume, mean rate, mean
//     net-to-supplier ratio)
//
// RBAC: read.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();

    const offersResp = await svc.from("treds_offers").select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (offersResp.error) throw new Error(offersResp.error.message);
    const offers = offersResp.data || [];

    const discResp = await svc.from("treds_discounts").select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (discResp.error) throw new Error(discResp.error.message);
    const discounts = discResp.data || [];

    // KPIs.
    const totalDiscounted = discounts.reduce((a, d) => a + Number(d.amount_inr || 0), 0);
    const totalNet = discounts.reduce((a, d) => a + Number(d.net_to_supplier_inr || 0), 0);
    const rates = discounts.map((d) => Number(d.rate_bps)).filter((n) => Number.isFinite(n));
    const meanRateBps = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

    // Buckets.
    const liveOffers   = offers.filter((o) => ["submitted", "buyer_pending", "live"].includes(o.auction_status));
    const wonOffers    = offers.filter((o) => o.auction_status === "won");
    const otherOffers  = offers.filter((o) => !["submitted", "buyer_pending", "live", "won"].includes(o.auction_status));
    const sandboxCount = offers.filter((o) => o.is_sandbox).length;

    return json(res, 200, {
      offers_live: liveOffers,
      offers_won: wonOffers,
      offers_other: otherOffers,
      discounts,
      kpis: {
        offers_count: offers.length,
        discounts_count: discounts.length,
        total_discounted_inr: Number(totalDiscounted.toFixed(2)),
        total_net_to_supplier_inr: Number(totalNet.toFixed(2)),
        mean_rate_bps: meanRateBps != null ? Number(meanRateBps.toFixed(0)) : null,
        sandbox_offers_count: sandboxCount,
      },
    });
  } catch (err) { sendError(res, err); }
}
