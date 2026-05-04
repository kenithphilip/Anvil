// POST /api/billing/stripe/webhook
//
// Receives Stripe events for the platform's connected accounts.
// Uses STRIPE_WEBHOOK_SECRET to verify the signature; without the
// secret the endpoint refuses every call (401) so a misconfigured
// deploy fails closed.
//
// We handle:
//   - checkout.session.completed       -> mark invoice partial/paid
//   - payment_intent.succeeded         -> ditto, with the canonical
//                                         payment_records row
//   - charge.refunded                  -> mark invoice partial/void
//
// Idempotency comes from `payment_records` having a unique on
// (tenant_id, stripe_payment_intent_id); a duplicate event upserts
// the same row, no duplicate billing.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { stripeClient, stripeIsConfigured } from "../../_lib/stripe-client.js";

const readRawBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => resolve(raw));
  req.on("error", reject);
});

const findInvoiceFromMetadata = async (svc, meta) => {
  const tenantId = meta?.anvil_tenant_id;
  const invoiceId = meta?.anvil_invoice_id;
  if (!tenantId || !invoiceId) return null;
  const inv = await svc.from("invoices").select("*").eq("tenant_id", tenantId).eq("id", invoiceId).maybeSingle();
  return inv.data || null;
};

const recordPayment = async (svc, invoice, paymentIntent, amount, currency) => {
  // Upsert via the unique (tenant_id, stripe_payment_intent_id)
  // constraint. If the same event is delivered twice, the row stays
  // single.
  const row = {
    tenant_id: invoice.tenant_id,
    invoice_id: invoice.id,
    amount,
    currency: (currency || invoice.currency || "USD").toUpperCase(),
    method: "stripe",
    stripe_payment_intent_id: paymentIntent || null,
    paid_at: new Date().toISOString(),
  };
  await svc.from("payment_records").upsert(row, { onConflict: "tenant_id,stripe_payment_intent_id" });
  // Audit so the meter sees it.
  await svc.from("audit_events").insert({
    tenant_id: invoice.tenant_id,
    action: "payment_received",
    object_type: "invoice",
    object_id: invoice.id,
    actor_user_id: null,
    detail: amount.toFixed(2) + " " + (currency || invoice.currency || "USD"),
  });
};

const updateInvoicePaid = async (svc, invoice, amount) => {
  const newPaid = Number(invoice.paid_amount || 0) + amount;
  const total = Number(invoice.grand_total || 0);
  const status = newPaid >= total - 0.01 ? "paid" : "partial";
  await svc.from("invoices").update({
    paid_amount: newPaid,
    status,
    paid_at: status === "paid" ? new Date().toISOString() : invoice.paid_at,
  }).eq("tenant_id", invoice.tenant_id).eq("id", invoice.id);
  if (status === "paid") {
    await svc.from("audit_events").insert({
      tenant_id: invoice.tenant_id,
      action: "invoice_paid",
      object_type: "invoice",
      object_id: invoice.id,
      detail: "stripe::" + total.toFixed(2),
    });
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  if (!stripeIsConfigured()) {
    return json(res, 503, { error: { message: "Stripe not configured" } });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return json(res, 401, { error: { message: "STRIPE_WEBHOOK_SECRET not set" } });
  }
  try {
    const stripe = stripeClient();
    const sig = req.headers["stripe-signature"];
    const raw = await readRawBody(req);
    let event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } catch (err) {
      return json(res, 400, { error: { message: "Webhook signature verification failed: " + err.message } });
    }

    const svc = serviceClient();

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const invoice = await findInvoiceFromMetadata(svc, session.metadata);
      if (invoice) {
        const amount = Number(session.amount_total || 0) / 100;
        const currency = (session.currency || invoice.currency || "USD").toUpperCase();
        await recordPayment(svc, invoice, session.payment_intent, amount, currency);
        await updateInvoicePaid(svc, invoice, amount);
      }
    } else if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const invoice = await findInvoiceFromMetadata(svc, pi.metadata);
      if (invoice) {
        const amount = Number(pi.amount_received || pi.amount || 0) / 100;
        const currency = (pi.currency || invoice.currency || "USD").toUpperCase();
        await recordPayment(svc, invoice, pi.id, amount, currency);
        await updateInvoicePaid(svc, invoice, amount);
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const invoice = await findInvoiceFromMetadata(svc, charge.metadata);
      if (invoice) {
        const refunded = Number(charge.amount_refunded || 0) / 100;
        const newPaid = Math.max(0, Number(invoice.paid_amount || 0) - refunded);
        const total = Number(invoice.grand_total || 0);
        const status = newPaid <= 0.01 ? "void" : "partial";
        await svc.from("invoices").update({ paid_amount: newPaid, status }).eq("tenant_id", invoice.tenant_id).eq("id", invoice.id);
        await svc.from("audit_events").insert({
          tenant_id: invoice.tenant_id,
          action: "invoice_refunded",
          object_type: "invoice",
          object_id: invoice.id,
          detail: refunded.toFixed(2),
        });
      }
    }

    return json(res, 200, { received: true });
  } catch (err) {
    sendError(res, err);
  }
}
