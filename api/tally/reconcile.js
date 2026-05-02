// POST /api/tally/reconcile
// Body: { orderId, tally_voucher_id?, status }
// Marks the order as RECONCILED (or FAILED_TALLY_IMPORT) once a downstream confirmation arrives.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const ALLOWED = new Set(["reconciled", "failed", "imported"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.orderId || !body.status) return json(res, 400, { error: { message: "orderId and status required" } });
    if (!ALLOWED.has(body.status)) return json(res, 400, { error: { message: "status must be reconciled | failed | imported" } });
    const svc = serviceClient();
    const tallyStatus = body.status;
    const orderStatus = body.status === "reconciled" ? "RECONCILED" : body.status === "imported" ? "EXPORTED_TO_TALLY" : "FAILED_TALLY_IMPORT";
    const { data: prev } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).single();
    if (!prev) return json(res, 404, { error: { message: "Order not found" } });
    const { error } = await svc.from("orders").update({ tally_status: tallyStatus, status: orderStatus }).eq("tenant_id", ctx.tenantId).eq("id", body.orderId);
    if (error) throw new Error(error.message);
    if (body.tally_voucher_id) {
      await svc.from("tally_voucher_records").update({ tally_voucher_id: body.tally_voucher_id, status: body.status }).eq("tenant_id", ctx.tenantId).eq("order_id", body.orderId);
    }
    await recordAudit(ctx, { action: "tally_reconcile", objectType: "order", objectId: body.orderId, detail: orderStatus, before: prev, after: { tally_status: tallyStatus } });
    await recordEvent(ctx, { caseId: body.orderId, eventType: "tally_reconciled", objectType: "order", objectId: body.orderId, detail: { status: orderStatus, tally_voucher_id: body.tally_voucher_id || null } });
    return json(res, 200, { ok: true, tally_status: tallyStatus, status: orderStatus });
  } catch (err) {
    sendError(res, err);
  }
}
