// GET  /api/source_pos?status=&order_id=&limit=
//      Lists source POs for the tenant, optionally filtered.
//
// POST /api/source_pos
// Body: { order_id, reference, supplier, country?, currency?,
//         total_foreign?, exchange_rate?, acknowledged_eta?,
//         payload? }
// Creates a draft source PO. Requires a parent order_id; the
// frontend's "New SPO" form picks one from the operator's open
// sales orders.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_STATUS = new Set([
  "DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER", "SUPPLIER_ACK",
  "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED", "CLOSED", "CANCELLED",
]);

const VALID_CCY = /^[A-Z]{3}$/;

const handleGet = async (req, res, ctx) => {
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
};

const handlePost = async (req, res, ctx) => {
  requirePermission(ctx, "write");
  const body = await readBody(req);
  if (!body) return json(res, 400, { error: { message: "Body required" } });

  const orderId = String(body.order_id || "").trim();
  const reference = String(body.reference || "").trim();
  const supplier = String(body.supplier || "").trim();
  if (!orderId) return json(res, 400, { error: { message: "order_id is required" } });
  if (!reference) return json(res, 400, { error: { message: "reference is required" } });
  if (!supplier) return json(res, 400, { error: { message: "supplier is required" } });

  const currency = body.currency ? String(body.currency).toUpperCase().trim() : null;
  if (currency && !VALID_CCY.test(currency)) {
    return json(res, 400, { error: { message: "currency must be a 3-letter ISO code" } });
  }

  const svc = serviceClient();

  // Verify the parent order belongs to this tenant. Without this
  // an operator on tenant A could attach a source PO to tenant B's
  // order by guessing the id.
  const orderQ = await svc.from("orders").select("id").eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
  if (orderQ.error) throw new Error(orderQ.error.message);
  if (!orderQ.data) return json(res, 404, { error: { message: "Parent order not found in this tenant" } });

  const ins = await svc.from("source_pos").insert({
    tenant_id: ctx.tenantId,
    order_id: orderId,
    reference,
    supplier,
    country: body.country || null,
    currency: currency || null,
    exchange_rate: body.exchange_rate != null ? Number(body.exchange_rate) : null,
    total_foreign: body.total_foreign != null ? Number(body.total_foreign) : null,
    total_inr: body.total_inr != null ? Number(body.total_inr) : null,
    acknowledged_eta: body.acknowledged_eta || null,
    payload: body.payload || {},
    status: "DRAFT",
  }).select("*").single();
  if (ins.error) throw new Error(ins.error.message);

  await recordAudit(ctx, {
    action: "source_po_created",
    objectType: "source_po",
    objectId: ins.data.id,
    detail: reference + " · " + supplier + " · order " + orderId,
  });

  return json(res, 201, { sourcePo: ins.data });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method === "GET")  return await handleGet(req, res, ctx);
    if (req.method === "POST") return await handlePost(req, res, ctx);
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
