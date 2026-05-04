// POST /api/billing/razorpay/webhook
//
// Razorpay POSTs payment events here. We verify the X-Razorpay-Signature
// HMAC over the raw body using razorpay_webhook_secret per tenant,
// look up the matching razorpay_order_id, flip the corresponding
// invoice status to paid / partial / refunded, and write a
// payment_records row + audit event.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { razorpayVerifyWebhookSignature } from "../../_lib/razorpay-client.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let data = ""; req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const raw = await readRaw(req);
    let body = null;
    try { body = JSON.parse(raw || "{}"); } catch (_e) { return json(res, 400, { error: { message: "invalid json" } }); }
    const signature = req.headers["x-razorpay-signature"] || req.headers["X-Razorpay-Signature"];
    const orderId = body?.payload?.payment?.entity?.order_id || body?.payload?.order?.entity?.id;
    if (!orderId) return json(res, 400, { error: { message: "no order_id in payload" } });
    const svc = serviceClient();
    // Find which tenant this order belongs to (we wrote it on order_create).
    const rpQ = await svc.from("razorpay_payments").select("*").eq("razorpay_order_id", orderId).maybeSingle();
    if (rpQ.error) throw new Error(rpQ.error.message);
    if (!rpQ.data) {
      return json(res, 404, { error: { message: "no matching razorpay_payments row" } });
    }
    const tenantId = rpQ.data.tenant_id;
    const tsQ = await svc.from("tenant_settings").select("razorpay_webhook_secret").eq("tenant_id", tenantId).maybeSingle();
    const secret = tsQ.data?.razorpay_webhook_secret;
    if (!secret || !razorpayVerifyWebhookSignature(raw, signature, secret)) {
      return json(res, 401, { error: { message: "invalid signature" } });
    }
    const event = body.event || "";
    const payment = body.payload?.payment?.entity || null;
    let nextStatus = rpQ.data.status;
    let invoiceUpdate = null;
    if (event === "payment.captured" || event === "order.paid") {
      nextStatus = "captured";
      invoiceUpdate = { status: "paid", paid_at: new Date().toISOString() };
    } else if (event === "payment.authorized") {
      nextStatus = "authorized";
    } else if (event === "payment.failed") {
      nextStatus = "failed";
    } else if (event === "refund.processed") {
      nextStatus = "refunded";
      invoiceUpdate = { status: "void" };
    }
    await svc.from("razorpay_payments").update({
      status: nextStatus,
      razorpay_payment_id: payment?.id || rpQ.data.razorpay_payment_id,
      method: payment?.method || rpQ.data.method,
      email: payment?.email || rpQ.data.email,
      contact: payment?.contact || rpQ.data.contact,
      raw: body,
    }).eq("id", rpQ.data.id);
    if (invoiceUpdate && rpQ.data.invoice_id) {
      const inv = await svc.from("invoices").select("grand_total, paid_amount").eq("id", rpQ.data.invoice_id).maybeSingle();
      if (inv.data) {
        const paid = Number(rpQ.data.amount || 0) + Number(inv.data.paid_amount || 0);
        await svc.from("invoices").update({
          ...invoiceUpdate,
          paid_amount: paid,
        }).eq("id", rpQ.data.invoice_id);
      }
    }
    // Lightweight audit (no ctx since this is webhook-driven).
    await svc.from("audit_events").insert({
      tenant_id: tenantId,
      actor_id: null,
      action: "razorpay_webhook::" + event,
      object_type: "razorpay_payments",
      object_id: rpQ.data.id,
      detail: "status=" + nextStatus,
    });
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
