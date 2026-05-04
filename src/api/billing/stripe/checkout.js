// POST /api/billing/stripe/checkout
// Body: { invoice_id, success_url?, cancel_url? }
//
// Creates a Stripe Checkout session in the tenant's connected
// account. Customer pays the tenant directly; Anvil takes the
// configured platform fee (in basis points). Returns the redirect
// URL the operator pastes into the customer email.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { stripeClient, stripeIsConfigured, tenantSettings } from "../../_lib/stripe-client.js";

const SESSION_TTL_HOURS = 24;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    if (!stripeIsConfigured()) {
      return json(res, 503, { error: { code: "STRIPE_NOT_CONFIGURED", message: "STRIPE_SECRET_KEY is not set." } });
    }
    const body = await readBody(req);
    if (!body?.invoice_id) return json(res, 400, { error: { message: "invoice_id required" } });

    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!settings.stripe_account_id) {
      return json(res, 409, { error: { code: "STRIPE_NOT_ONBOARDED", message: "Stripe Connect onboarding incomplete for this tenant." } });
    }
    if (!settings.stripe_charges_enabled) {
      return json(res, 409, { error: { code: "STRIPE_CHARGES_DISABLED", message: "Stripe has not enabled charges on this account yet." } });
    }

    const invQ = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
    if (invQ.error) throw new Error("invoices read: " + invQ.error.message);
    if (!invQ.data) return json(res, 404, { error: { message: "Invoice not found" } });
    if (invQ.data.status === "paid" || invQ.data.status === "void") {
      return json(res, 409, { error: { message: "Invoice is " + invQ.data.status } });
    }

    const stripe = stripeClient();
    const grand = Math.round(Number(invQ.data.grand_total) * 100); // cents
    const platformFeeBps = Math.max(0, Math.min(1000, settings.stripe_platform_fee_bps || 0));
    const applicationFee = Math.round(grand * platformFeeBps / 10_000);

    const baseUrl = process.env.PUBLIC_APP_URL || (req.headers.origin || "");
    const successUrl = body.success_url || (baseUrl ? baseUrl + "/#/invoices?paid=" + invQ.data.id : "https://example.com/success");
    const cancelUrl  = body.cancel_url  || (baseUrl ? baseUrl + "/#/invoices?cancelled=" + invQ.data.id : "https://example.com/cancel");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: (invQ.data.currency || "USD").toLowerCase(),
          unit_amount: grand,
          product_data: {
            name: "Invoice " + invQ.data.invoice_number,
            description: invQ.data.notes || "Issued " + invQ.data.issue_date,
          },
        },
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        application_fee_amount: applicationFee || undefined,
        metadata: {
          anvil_tenant_id: ctx.tenantId,
          anvil_invoice_id: invQ.data.id,
          anvil_invoice_number: invQ.data.invoice_number,
        },
      },
      metadata: {
        anvil_tenant_id: ctx.tenantId,
        anvil_invoice_id: invQ.data.id,
      },
    }, { stripeAccount: settings.stripe_account_id });

    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
    await svc.from("invoices").update({
      stripe_payment_intent_id: session.payment_intent || null,
      stripe_checkout_url: session.url,
      stripe_checkout_expires_at: expiresAt,
    }).eq("tenant_id", ctx.tenantId).eq("id", invQ.data.id);

    await recordAudit(ctx, {
      action: "stripe_checkout_created",
      objectType: "invoice",
      objectId: invQ.data.id,
      detail: session.id,
    });

    return json(res, 200, {
      url: session.url,
      session_id: session.id,
      expires_at: expiresAt,
      platform_fee_cents: applicationFee,
    });
  } catch (err) {
    sendError(res, err);
  }
}
