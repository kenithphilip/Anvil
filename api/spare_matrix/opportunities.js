// GET /api/spare_matrix/opportunities?customer_id=
// Finds parts the customer has installed (or is similar to other customers' installed base)
// but never bought. Useful for sales outreach.

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
    const customerId = req.query.customer_id;
    if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
    const svc = serviceClient();
    const purchased = await svc.from("orders").select("result").eq("tenant_id", ctx.tenantId).eq("customer_id", customerId).not("result", "is", null).limit(200);
    const purchasedSet = new Set();
    (purchased.data || []).forEach((o) => {
      ((o.result && o.result.salesOrder && o.result.salesOrder.lineItems) || []).forEach((li) => {
        const key = String(li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
        if (key) purchasedSet.add(key);
      });
    });
    const allRecs = await svc.from("spare_recommendations").select("*").eq("tenant_id", ctx.tenantId).order("criticality_score", { ascending: false }).limit(200);
    const opportunities = (allRecs.data || []).filter((r) => !purchasedSet.has(String(r.part_no).toUpperCase())).slice(0, 25);
    return json(res, 200, { opportunities, alreadyPurchased: purchasedSet.size });
  } catch (err) {
    sendError(res, err);
  }
}
