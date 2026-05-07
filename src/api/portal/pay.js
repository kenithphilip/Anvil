// POST /api/portal/pay
// Body: { token, invoice_id, gateway?: 'stripe' | 'razorpay' }
//
// Public-facing pay-now: buyer clicks Pay on the portal, we create a
// Stripe Checkout session OR a Razorpay Order depending on the
// tenant's configured gateway (or the override they pass), and
// return the redirect URL or the inline checkout config. The
// invoice's tenant gates which gateway is allowed; both can be
// active for international + India splits.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { stripeClient, stripeIsConfigured, tenantSettings } from "../_lib/stripe-client.js";
import { razorpayDecryptCreds, razorpayCreateOrder, razorpayIsConfigured } from "../_lib/razorpay-client.js";

const validateToken = async (svc, token) => {
  if (!token) return { error: { code: 401, message: "token required" } };
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error || !r.data) return { error: { code: 404, message: "token not found" } };
  const t = r.data;
  if (t.revoked_at) return { error: { code: 401, message: "token revoked" } };
  if (t.expires_at && new Date(t.expires_at) < new Date()) return { error: { code: 401, message: "token expired" } };
  if (!t.scopes.includes("pay")) return { error: { code: 403, message: "pay not in token scopes" } };
  return { token: t };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    if (!body?.token || !body?.invoice_id) {
      return json(res, 400, { error: { message: "token and invoice_id required" } });
    }
    const svc = serviceClient();
    const v = await validateToken(svc, body.token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;
    const invQ = await svc.from("invoices").select("*").eq("tenant_id", t.tenant_id).eq("id", body.invoice_id).maybeSingle();
    if (invQ.error) throw new Error(invQ.error.message);
    const inv = invQ.data;
    if (!inv) return json(res, 404, { error: { message: "invoice not found" } });
    if (inv.customer_id !== t.customer_id) return json(res, 403, { error: { message: "invoice doesn't match token" } });
    if (inv.status === "paid" || inv.status === "void") return json(res, 409, { error: { message: "invoice not payable", status: inv.status } });
    const settings = await tenantSettings(svc, t.tenant_id);
    const settingsRp = razorpayDecryptCreds(settings);

    const gateway = body.gateway
      || (inv.currency === "INR" && razorpayIsConfigured(settingsRp) ? "razorpay"
          : (stripeIsConfigured() && settings.stripe_account_id ? "stripe"
          : (razorpayIsConfigured(settingsRp) ? "razorpay" : null)));

    if (gateway === "razorpay") {
      const amount = Math.round(Number(inv.grand_total || 0) * 100);
      const resp = await razorpayCreateOrder(settingsRp, {
        amount,
        currency: inv.currency || "INR",
        receipt: "INV-" + inv.invoice_number,
        notes: { invoice_id: inv.id, tenant_id: t.tenant_id, portal_token_id: t.id },
      });
      if (!resp.ok) return json(res, 502, { ok: false, error: resp.body?.error?.description || resp.body?.error });
      await svc.from("razorpay_payments").insert({
        tenant_id: t.tenant_id, invoice_id: inv.id, razorpay_order_id: resp.body.id,
        amount: inv.grand_total, currency: inv.currency || "INR", status: "created", raw: resp.body,
      });
      return json(res, 200, {
        ok: true, gateway: "razorpay",
        key_id: settingsRp.razorpay_key_id,
        order_id: resp.body.id, amount, currency: resp.body.currency,
      });
    }

    if (gateway === "stripe") {
      if (!stripeIsConfigured() || !settings.stripe_account_id) {
        return json(res, 409, { error: { code: "STRIPE_NOT_CONFIGURED", message: "Stripe not configured for this tenant" } });
      }
      const stripe = stripeClient();
      const platformFeeBps = Number(settings.stripe_platform_fee_bps || 0);
      const amount = Math.round(Number(inv.grand_total || 0) * 100);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: (inv.currency || "USD").toLowerCase(),
            product_data: { name: "Invoice " + inv.invoice_number },
            unit_amount: amount,
          },
          quantity: 1,
        }],
        payment_intent_data: {
          application_fee_amount: platformFeeBps > 0 ? Math.floor((amount * platformFeeBps) / 10_000) : 0,
          transfer_data: { destination: settings.stripe_account_id },
          // Audit P1.1 (May 2026): the Stripe webhook reads
          // metadata.anvil_tenant_id / metadata.anvil_invoice_id when
          // reconciling a payment back to the invoice. The portal
          // path used un-prefixed keys, so the webhook lookup
          // returned null, no payment_records row was written, the
          // invoice stayed at status='sent', and the dunning agent
          // kept emailing customers who had already paid. Use the
          // same prefixed keys as billing/stripe/checkout.js.
          metadata: {
            anvil_tenant_id: t.tenant_id,
            anvil_invoice_id: inv.id,
            anvil_invoice_number: inv.invoice_number,
            anvil_portal_token_id: t.id,
          },
        },
        success_url: (body.success_url || "/portal/" + body.token + "?paid=1"),
        cancel_url: (body.cancel_url || "/portal/" + body.token + "?paid=0"),
      });
      await svc.from("invoices").update({ stripe_payment_intent_id: session.payment_intent }).eq("id", inv.id);
      return json(res, 200, { ok: true, gateway: "stripe", url: session.url, id: session.id });
    }

    return json(res, 409, { error: { code: "NO_GATEWAY", message: "No payment gateway configured" } });
  } catch (err) { sendError(res, err); }
}
