// POST /api/invoices/payment
//
// Manual cash-application fallback for markets where hosted card
// gateways (Stripe/Razorpay) are not the norm. Records a received
// payment against an invoice and advances its status (partial/paid),
// reusing the same integer-cents accounting as the Stripe webhook.
//
// Methods: bank_transfer | rtgs | neft | wire | cheque | imps | upi |
//          cash | card | other  (see PAYMENT_METHODS).
//
// Body: { invoice_id, amount, method?, reference?, paid_at?, note?,
//         tds?, tds_section? }
//
// OEM customers withhold TDS at source: `amount` is the cash actually
// received and `tds` is the tax withheld. We post the cash receipt and,
// when tds > 0, a second "tds" posting so cash + TDS clears the invoice
// in full (mirrors SAP clearing an AR open item with cash + a TDS GL
// line). Without this, every OEM payment would leave a phantom
// short-pay balance.
//
// Recording cash received clears AR, so it requires the same `approve`
// permission as moving an invoice to paid in /invoices/[id].

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { applyPayment, PAYMENT_METHODS } from "../_lib/payments.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");

    const body = await readBody(req);
    const invoiceId = body.invoice_id || body.id;
    if (!invoiceId) return json(res, 400, { error: { message: "invoice_id required" } });

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { error: { message: "amount must be a positive number" } });
    }
    const method = String(body.method || "bank_transfer").toLowerCase();
    if (!PAYMENT_METHODS.has(method)) {
      return json(res, 400, { error: { message: "unknown payment method: " + method } });
    }

    const svc = serviceClient();
    const inv = await svc.from("invoices").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", invoiceId).maybeSingle();
    if (inv.error) throw new Error(inv.error.message);
    if (!inv.data) return json(res, 404, { error: { message: "Not found" } });
    if (inv.data.status === "void") {
      return json(res, 409, { error: { message: "Cannot record a payment against a void invoice" } });
    }

    const tds = Number(body.tds || 0);
    if (!Number.isFinite(tds) || tds < 0) {
      return json(res, 400, { error: { message: "tds must be zero or a positive number" } });
    }

    let result = await applyPayment(svc, inv.data, {
      amount,
      method,
      reference: body.reference || null,
      paidAt: body.paid_at || null,
      note: body.note || null,
      actorId: ctx.user?.id || null,
    });

    // TDS withholding posting: the OEM deducted tax at source, so this
    // portion settles the invoice as a tax credit rather than leaving an
    // outstanding balance. Posted as its own payment_records row so cash
    // vs TDS stay distinguishable in reporting. Re-base on the just-
    // updated invoice (merge guards against a partial returned row).
    if (tds > 0 && !result.duplicate) {
      const afterCash = { ...inv.data, ...result.invoice };
      result = await applyPayment(svc, afterCash, {
        amount: tds,
        method: "tds",
        reference: body.tds_section || body.reference || null,
        paidAt: body.paid_at || null,
        note: "TDS withheld at source",
        actorId: ctx.user?.id || null,
      });
    }

    await recordAudit(ctx, {
      action: "payment_received",
      objectType: "invoice",
      objectId: invoiceId,
      after: { amount, tds, method, reference: body.reference || null, status: result.status },
    });
    // Separate billable outcome when the invoice fully clears, matching
    // the verb /invoices/[id] emits on a manual move to paid.
    if (result.status === "paid") {
      await recordAudit(ctx, { action: "invoice_paid", objectType: "invoice", objectId: invoiceId });
    }

    return json(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}
