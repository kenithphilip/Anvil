// GET /api/cost/margin_history?customer_id=
// Returns historical margin baseline for a customer using past orders' price comp data.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const median = (arr) => {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
};

const computeMargin = (so, priceComp) => {
  if (!so || !priceComp || !priceComp.lineItems) return null;
  const compByPart = {};
  priceComp.lineItems.forEach((row) => {
    const key = String(row.partNumber || row.partNo || "").toUpperCase();
    if (key) compByPart[key] = row;
  });
  let selling = 0, landed = 0;
  (so.lineItems || []).forEach((li) => {
    const key = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
    const match = compByPart[key];
    selling += Number(li.amount) || 0;
    if (match) landed += (Number(match.landedCostINR != null ? match.landedCostINR : (match.unitInr != null ? match.unitInr : 0))) * (Number(li.qty) || 0);
  });
  if (selling === 0) return null;
  return { selling, landed, marginPct: ((selling - landed) / selling) * 100 };
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
    if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
    const { data, error } = await svc.from("orders").select("id, created_at, result").eq("tenant_id", ctx.tenantId).eq("customer_id", customerId).not("result", "is", null).order("created_at", { ascending: false }).limit(40);
    if (error) throw new Error(error.message);
    const margins = [];
    (data || []).forEach((row) => {
      const so = row.result && row.result.salesOrder;
      const priceComp = row.result && row.result.priceComposition;
      const m = computeMargin(so, priceComp);
      if (m) margins.push({ ...m, at: row.created_at, orderId: row.id });
    });
    if (!margins.length) return json(res, 200, { sample: 0 });
    const pcts = margins.map((m) => m.marginPct);
    return json(res, 200, {
      sample: margins.length,
      medianMarginPct: median(pcts),
      lowMarginPct: Math.min(...pcts),
      highMarginPct: Math.max(...pcts),
      recent: margins.slice(0, 10),
    });
  } catch (err) {
    sendError(res, err);
  }
}
