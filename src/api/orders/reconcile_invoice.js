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
import { reconcileInvoiceAgainstOrder, compareTotals, countsTowardBilled, dispatchLookup } from "../_lib/invoice-reconcile.js";
import { assessDispatchReadiness } from "../_lib/dispatch-readiness.js";

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

    // What has actually gone out of the door, for the under-delivery leg.
    //
    // Single order, so .eq and no .in() chunking — the precedent is the sibling
    // endpoint reconcile_quotes.js and _lib/dispatch-register-send.js.
    //
    // Best-effort on purpose: a read failure must leave the leg UNCHECKED, not
    // report nothing shipped. dispatchLookup([]) and dispatchLookup(null) both
    // return present: false, so the catch needs no special case.
    let dispatchRows = null;
    try {
      const dq = await svc.from("dispatch_lines")
        .select("line_index, part_no, description, dispatched_qty, uom, dispatch_date, invoice_number")
        .eq("tenant_id", ctx.tenantId).eq("order_id", orderId);
      if (!dq.error) dispatchRows = dq.data || [];
    } catch (_e) { /* leave unchecked */ }

    const result = reconcileInvoiceAgainstOrder(orderLines, subjectLines, priorInvoices, {
      priceTolerancePct: body.price_tolerance_pct,
      dispatch: dispatchLookup(dispatchRows),
    });

    // ── Can the consignment behind this invoice lawfully move? ──────────────
    //
    // The owner's despatch register is kept in Tally against each invoice, and
    // what it captures is the docket number and the e-way bill details. Those
    // are the two things that hold a consignment: goods moving without a
    // required e-way bill can be detained, and without a docket the buyer's
    // stores cannot tie the delivery to the invoice.
    //
    // Every read here is best-effort and every failure leaves the assessment
    // UNDECIDED rather than passing, because dispatch-readiness.js returns
    // required: null (never false) when an input is missing.
    let sellerGstin = null;
    let ewaySettings = {};
    try {
      const ts = await svc.from("tenant_settings")
        .select("einvoice_seller_gstin").eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!ts.error) sellerGstin = ts.data?.einvoice_seller_gstin || null;
    } catch (_e) { /* undecided */ }

    // SEPARATE query, deliberately. Migration 225 adds these two columns and
    // migrations here apply by hand, so on any deployment that has not run it
    // the select returns 42703 — and PostgREST rejects the WHOLE statement, not
    // just the unknown column. Asking for them beside einvoice_seller_gstin
    // would therefore lose the GSTIN too and make every invoice undecidable.
    try {
      const th = await svc.from("tenant_settings")
        .select("eway_threshold_inr, eway_threshold_intrastate_inr")
        .eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!th.error && th.data) ewaySettings = th.data;
    } catch (_e) { /* module falls back to its documented defaults */ }

    let buyerGstin = null;
    if (order.customer_id) {
      try {
        const cq = await svc.from("customers").select("gstin")
          .eq("tenant_id", ctx.tenantId).eq("id", order.customer_id).maybeSingle();
        if (!cq.error) buyerGstin = cq.data?.gstin || null;
      } catch (_e) { /* undecided */ }
    }

    // Newest first: a re-filed bill supersedes a cancelled one.
    let ewayBill = null;
    if (subject?.id) {
      try {
        const eq = await svc.from("eway_bills")
          .select("id, status, ewb_no, vehicle_no, trans_mode, created_at")
          .eq("tenant_id", ctx.tenantId).eq("invoice_id", subject.id)
          .order("created_at", { ascending: false }).limit(1);
        if (!eq.error && eq.data?.length) ewayBill = eq.data[0];
      } catch (_e) { /* undecided */ }
    }

    // The docket comes off the despatch register when it has one. Reuses the
    // rows already fetched above for the under-delivery leg.
    const docket = (dispatchRows || []).map((d) => d?.lr_number).find((v) => v) || null;

    const dispatchReadiness = subject
      ? assessDispatchReadiness({
          invoiceValue: subject.grand_total,
          sellerGstin, buyerGstin, ewayBill, docket, settings: ewaySettings,
        })
      : null;

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
      dispatch_readiness: dispatchReadiness,
      prior_invoices: priorInvoices.map((i) => ({
        id: i.id, invoice_number: i.invoice_number, status: i.status,
        counted: countsTowardBilled(i),
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
}
