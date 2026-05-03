// GET /api/source_pos?status=&order_id=&limit=
// Lists source POs for the tenant, optionally filtered.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const ALLOWED_STATUS = new Set([
  "DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER", "SUPPLIER_ACK",
  "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED", "CLOSED", "CANCELLED",
]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
    const svc = serviceClient();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    let query = svc.from("source_pos").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(limit);
    const status = req.query.status;
    if (status) {
      const list = String(status).split(",").map((s) => s.trim()).filter((s) => ALLOWED_STATUS.has(s));
      if (list.length === 1) query = query.eq("status", list[0]);
      else if (list.length > 1) query = query.in("status", list);
    }
    if (req.query.order_id) query = query.eq("order_id", req.query.order_id);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return json(res, 200, { sourcePos: data || [] });
  } catch (err) {
    sendError(res, err);
  }
}
