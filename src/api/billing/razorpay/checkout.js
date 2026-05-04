// POST /api/billing/razorpay/checkout
// Body: { invoice_id }
//
// Creates a Razorpay Order for the invoice's grand_total and returns
// the checkout configuration the customer-facing portal uses to
// open the standard Razorpay Checkout (key_id, order_id, amount,
// currency, prefill).

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { tenantSettings } from "../../_lib/stripe-client.js";
import { razorpayDecryptCreds, razorpayCreateOrder, razorpayIsConfigured } from "../../_lib/razorpay-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.invoice_id) return json(res, 400, { error: { message: "invoice_id required" } });
    const svc = serviceClient();
    const settings = razorpayDecryptCreds(await tenantSettings(svc, ctx.tenantId));
    if (!razorpayIsConfigured(settings)) {
      return json(res, 409, { error: { code: "RAZORPAY_NOT_CONFIGURED", message: "Razorpay not configured" } });
    }
    const invQ = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
    if (invQ.error) throw new Error(invQ.error.message);
    if (!invQ.data) return json(res, 404, { error: { message: "Invoice not found" } });
    const amount = Math.round(Number(invQ.data.grand_total || 0) * 100); // paise
    if (amount <= 0) return json(res, 400, { error: { message: "Invoice has no positive total" } });
    const customerQ = invQ.data.customer_id
      ? await svc.from("customers").select("*").eq("id", invQ.data.customer_id).maybeSingle()
      : { data: null };
    const resp = await razorpayCreateOrder(settings, {
      amount,
      currency: invQ.data.currency || "INR",
      receipt: "INV-" + invQ.data.invoice_number,
      notes: { invoice_id: invQ.data.id, tenant_id: ctx.tenantId },
    });
    if (!resp.ok) {
      return json(res, 502, { ok: false, status: resp.status, error: resp.body?.error?.description || resp.body?.error });
    }
    const order = resp.body;
    await svc.from("razorpay_payments").insert({
      tenant_id: ctx.tenantId,
      invoice_id: invQ.data.id,
      razorpay_order_id: order.id,
      amount: invQ.data.grand_total,
      currency: invQ.data.currency || "INR",
      status: "created",
      raw: order,
    });
    await recordAudit(ctx, {
      action: "razorpay_order_created",
      objectType: "invoice",
      objectId: invQ.data.id,
      detail: "order_id=" + order.id,
    });
    return json(res, 200, {
      ok: true,
      key_id: settings.razorpay_key_id,
      order_id: order.id,
      amount,
      currency: order.currency,
      invoice_id: invQ.data.id,
      prefill: customerQ.data
        ? {
            name: customerQ.data.customer_name || "",
            email: customerQ.data.contact_email || "",
            contact: customerQ.data.contact_phone || "",
          }
        : {},
    });
  } catch (err) { sendError(res, err); }
}
