// POST /api/spare_matrix/kit
// Body: { customer_id, gun_models?: [{model, qty}], target_months? }
// Returns a recommended initial spare kit for a customer or project.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    if (!body || !body.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
    const months = Number(body.target_months || 12);
    const svc = serviceClient();
    const recs = await svc.from("spare_recommendations").select("*").eq("tenant_id", ctx.tenantId).eq("customer_id", body.customer_id).order("criticality_score", { ascending: false }).limit(60);
    if (recs.error) throw new Error(recs.error.message);
    const installed = await svc.from("installed_base").select("gun_model, installed_qty").eq("tenant_id", ctx.tenantId).eq("customer_id", body.customer_id);
    const installedMap = new Map();
    (installed.data || []).forEach((row) => { installedMap.set(row.gun_model, Number(row.installed_qty) || 0); });
    const kit = (recs.data || []).map((r) => {
      const monthlyDemand = (Number(r.recommended_qty) || 0) / 12;
      const targetQty = Math.max(1, Math.round(monthlyDemand * months));
      return { partNo: r.part_no, recommended_qty: targetQty, score: r.criticality_score, reason: r.reason };
    });
    return json(res, 200, { kit, installed: Array.from(installedMap.entries()).map(([model, qty]) => ({ model, qty })), targetMonths: months });
  } catch (err) {
    sendError(res, err);
  }
}
