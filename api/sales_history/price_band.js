// GET /api/sales_history/price_band?customer_id=&part_no=
// Returns last sold price, median, min, max for a part across orders for that customer.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const median = (arr) => {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const customerId = req.query.customer_id;
    const partNo = String(req.query.part_no || "").toUpperCase();
    if (!partNo) return json(res, 400, { error: { message: "part_no required" } });
    let q = svc.from("orders").select("id, created_at, result, customer_id").eq("tenant_id", ctx.tenantId).not("result", "is", null).order("created_at", { ascending: false }).limit(60);
    if (customerId) q = q.eq("customer_id", customerId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const hits = [];
    (data || []).forEach((row) => {
      const lines = (row.result && row.result.salesOrder && row.result.salesOrder.lineItems) || [];
      lines.forEach((li) => {
        const key = String(li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
        if (key === partNo && Number(li.rate)) {
          hits.push({ rate: Number(li.rate), qty: Number(li.qty) || 0, at: row.created_at, orderId: row.id });
        }
      });
    });
    if (!hits.length) return json(res, 200, { sample: 0 });
    const rates = hits.map((h) => h.rate);
    const last = hits[0];
    return json(res, 200, {
      sample: hits.length,
      lastRate: last.rate, lastAt: last.at,
      medianRate: median(rates),
      minRate: Math.min(...rates),
      maxRate: Math.max(...rates),
      history: hits.slice(0, 10),
    });
  } catch (err) {
    sendError(res, err);
  }
}
