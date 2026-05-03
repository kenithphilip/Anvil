// GET /api/spare_matrix/obsolete
// Lists parts not seen in any SO or BOM for N months. Useful for clean-up.

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
    const months = Number(req.query.months || 18);
    const cutoff = new Date(Date.now() - months * 30 * 86400 * 1000).toISOString();
    const svc = serviceClient();
    const recent = await svc.from("orders").select("result").eq("tenant_id", ctx.tenantId).gte("created_at", cutoff).not("result", "is", null);
    const recentParts = new Set();
    (recent.data || []).forEach((o) => {
      ((o.result && o.result.salesOrder && o.result.salesOrder.lineItems) || []).forEach((li) => {
        const key = String(li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
        if (key) recentParts.add(key);
      });
    });
    const recs = await svc.from("spare_recommendations").select("part_no").eq("tenant_id", ctx.tenantId);
    const obsolete = (recs.data || []).filter((r) => !recentParts.has(String(r.part_no).toUpperCase())).map((r) => r.part_no).slice(0, 200);
    return json(res, 200, { obsolete, threshold_months: months, sampled: recent.data ? recent.data.length : 0 });
  } catch (err) {
    sendError(res, err);
  }
}
