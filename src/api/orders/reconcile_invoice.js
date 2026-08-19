// POST /api/orders/reconcile_invoice
//   { order_id, invoice_id?, invoice_lines?, price_tolerance_pct? }
//
// Does an invoice agree with the customer's purchase order?
//
// A large buyer books an incoming invoice against the PO it was raised for.
// If the lines, quantities or prices disagree, no goods receipt is raised —
// and no GRN means no payment. This answers that question BEFORE the invoice
// goes out, while it is still free to fix.
//
// READ-ONLY, DELIBERATELY. It writes nothing: no invoice status, no order
// status, no findings row, no variance decision. Two things will tempt a
// write later and are explicitly out of scope here:
//   - blocking invoice SEND on a blocking verdict (scope doc PR3), and
//   - recording accept / request-amendment / cancel (PR4, needs a table).
// Landing the answer before the enforcement means the numbers can be checked
// against real orders without anything being refused in production first.
//
// Mirrors orders/reconcile_quotes.js in auth, body shape and error handling.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { reconcileInvoiceAgainstOrder, compareTotals, countsTowardBilled } from "../_lib/invoice-reconcile.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    // "write", matching reconcile_quotes.js. This endpoint changes nothing,
    // but it exposes commercial pricing line by line and should not be a
    // read-only viewer's to pull.
    requirePermission(ctx, "write");
    const body = (await readBody(req)) || {};
    const orderId = body.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      .select("id, customer_id, po_number, result")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;

    const orderLines = Array.isArray(order.result?.salesOrder?.lineItems)
      ? order.result.salesOrder.lineItems
      : [];
    if (!orderLines.length) {
      return json(res, 400, { error: { message: "Order has no lines to reconcile against." } });
    }

    // Every invoice for this order. Needed even when checking a draft: the
    // quantity question is cumulative, so the answer depends on what the
    // OTHER invoices already billed.
    const invQ = await svc.from("invoices")
      .select("id, invoice_number, status, voided_at, line_items, grand_total, currency, customer_po_number, created_at")
      .eq("tenant_id", ctx.tenantId).eq("order_id", orderId)
      .order("created_at", { ascending: true });
    // customer_po_number arrived in migration 214, which is applied BY HAND.
    // PostgREST rejects the whole select over one unknown column, so a tenant
    // behind on 214 would get a 500 from an endpoint that has nothing to do
    // with that column. Retry without it and report the reference as unknown
    // rather than as missing — those are different answers.
    let invoices = invQ.data;
    let poRefKnown = true;
    if (invQ.error) {
      if (invQ.error.code === "42703" || /customer_po_number/i.test(invQ.error.message || "")) {
        poRefKnown = false;
        const retry = await svc.from("invoices")
          .select("id, invoice_number, status, voided_at, line_items, grand_total, currency, created_at")
          .eq("tenant_id", ctx.tenantId).eq("order_id", orderId)
          .order("created_at", { ascending: true });
        if (retry.error) throw new Error("invoices read: " + retry.error.message);
        invoices = retry.data;
      } else {
        throw new Error("invoices read: " + invQ.error.message);
      }
    }
    invoices = invoices || [];

    // WHICH invoice is under test.
    //   invoice_id     — an existing one (typically a draft about to be sent)
    //   invoice_lines  — a proposed set, before any row exists
    //   neither        — the newest invoice on the order
    let subject = null;
    let subjectLines = null;
    if (Array.isArray(body.invoice_lines)) {
      subjectLines = body.invoice_lines;
    } else if (body.invoice_id) {
      subject = invoices.find((i) => i.id === body.invoice_id) || null;
      if (!subject) return json(res, 404, { error: { message: "Invoice not found on this order" } });
      subjectLines = Array.isArray(subject.line_items) ? subject.line_items : [];
    } else {
      subject = invoices.length ? invoices[invoices.length - 1] : null;
      if (!subject) {
        return json(res, 400, {
          error: { message: "This order has no invoice yet. Pass invoice_lines to check a proposed one." },
        });
      }
      subjectLines = Array.isArray(subject.line_items) ? subject.line_items : [];
    }

    // Prior = every OTHER invoice. The subject must not count itself toward
    // the cumulative billed quantity, or a sent invoice would always read as
    // double-billed against itself.
    const priorInvoices = invoices.filter((i) => !subject || i.id !== subject.id);

    const result = reconcileInvoiceAgainstOrder(orderLines, subjectLines, priorInvoices, {
      priceTolerancePct: body.price_tolerance_pct,
    });

    const totals = subject
      ? compareTotals(subject.grand_total, orderLines, { priceTolerancePct: body.price_tolerance_pct })
      : null;

    // The PO reference the buyer books against. Its absence is itself a reason
    // a receipt is rejected, so it is reported beside the line verdicts.
    const poReference = subject
      ? {
          known: poRefKnown,
          invoice_ref: poRefKnown ? (subject.customer_po_number || null) : null,
          order_po_number: order.po_number || null,
          missing: poRefKnown ? !subject.customer_po_number : null,
        }
      : null;

    return json(res, 200, {
      order_id: orderId,
      order_po_number: order.po_number || null,
      invoice: subject
        ? { id: subject.id, invoice_number: subject.invoice_number, status: subject.status, currency: subject.currency }
        : { id: null, invoice_number: null, status: "proposed", currency: null },
      ...result,
      totals,
      po_reference: poReference,
      prior_invoices: priorInvoices.map((i) => ({
        id: i.id, invoice_number: i.invoice_number, status: i.status,
        counted: countsTowardBilled(i),
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
}
