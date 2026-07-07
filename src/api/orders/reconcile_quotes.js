// POST /api/orders/reconcile_quotes   body: { order_id, price_tolerance_pct? }
//
// Auto-reconcile a received PO/SO against the customer's quotes — the
// operator uploads the PO and Anvil finds the corresponding quotes on its
// own. Pools ALL of the order customer's quotes (across every quote, not a
// single hand-picked one), matches each PO line by part number, enriches
// it with the quoted HSN / discounted rate / tax / source, stamps which
// quote priced each line, and stores a verification report (price/qty/part
// exceptions) on the order so the SO renders complete and the operator
// only reviews the flags.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { reconcilePoAgainstQuotes, comparePaymentTerms } from "../_lib/quote-reconcile.js";

// Quotes in these states can't have priced this PO.
const EXCLUDED_QUOTE_STATUSES = ["CANCELLED"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = (await readBody(req)) || {};
    const orderId = body.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      .select("id, customer_id, result, quote_id, quote_number")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;
    if (!order.customer_id) {
      return json(res, 400, { error: { message: "Order has no customer; cannot find matching quotes. Set the customer first." } });
    }
    const orderLines = Array.isArray(order.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : [];
    if (!orderLines.length) return json(res, 400, { error: { message: "Order has no lines to reconcile." } });

    // 1. All the customer's quotes (most recent first = preferred price).
    const quotesQ = await svc.from("quotes")
      .select("id, quote_number, created_at, status, terms")
      .eq("tenant_id", ctx.tenantId).eq("customer_id", order.customer_id)
      .not("status", "in", "(" + EXCLUDED_QUOTE_STATUSES.join(",") + ")")
      .order("created_at", { ascending: false });
    if (quotesQ.error) throw new Error("quotes read: " + quotesQ.error.message);
    const quotes = quotesQ.data || [];
    const quoteMeta = new Map(quotes.map((q) => [q.id, q]));

    // 2. Their quote lines, tagged with quote provenance, in preferred order.
    let quoteLines = [];
    if (quotes.length) {
      const qlQ = await svc.from("quote_lines")
        .select("quote_id, line_index, part_no, description, qty, uom, hsn_sac, customer_part_number, source_country, listed_unit_price, discount_pct, discounted_unit_price, line_amount, cgst_pct, sgst_pct, igst_pct")
        .eq("tenant_id", ctx.tenantId).in("quote_id", quotes.map((q) => q.id));
      if (qlQ.error) throw new Error("quote_lines read: " + qlQ.error.message);
      quoteLines = (qlQ.data || []).map((ql) => {
        const m = quoteMeta.get(ql.quote_id);
        return { ...ql, _quote_id: ql.quote_id, _quote_number: m?.quote_number || null, _quote_created_at: m?.created_at || null };
      }).sort((a, b) => String(b._quote_created_at || "").localeCompare(String(a._quote_created_at || "")));
    }

    // 3. Reconcile.
    const rec = reconcilePoAgainstQuotes(orderLines, quoteLines, {
      priceTolerancePct: body.price_tolerance_pct != null ? Number(body.price_tolerance_pct) : 0.5,
    });

    // 3b. Header-level payment-terms check: the PO's payment terms
    // (extracted verbatim) vs the primary matched quote's terms.
    const primary = rec.quotes_used[0] || null;
    const poPayTerms = order.result?.salesOrder?.customer?.payment_terms
      || order.result?.salesOrder?.payment_terms || null;
    const primaryQuoteTerms = primary ? (quoteMeta.get(primary.quote_id)?.terms || null) : null;
    const paymentTerms = comparePaymentTerms(poPayTerms, primaryQuoteTerms);
    if (primary) paymentTerms.source_quote_number = primary.quote_number;
    if (paymentTerms.verdict === "mismatch") {
      rec.flags.push({
        line_no: null, part_no: null, verdict: "payment_terms_mismatch",
        po_rate: null, quote_rate: null, price_delta_pct: null,
        source_quote_number: primary?.quote_number || null,
        po_terms: paymentTerms.po_terms, quote_terms: paymentTerms.quote_terms,
      });
    }

    // 4. Persist enriched lines + report; link the primary quote (most lines).
    const nowIso = new Date().toISOString();
    const newResult = {
      ...(order.result || {}),
      salesOrder: { ...(order.result?.salesOrder || {}), lineItems: rec.lines },
      quoteReconciliation: {
        as_of: nowIso,
        summary: rec.summary,
        quotes_used: rec.quotes_used,
        ambiguous_parts: rec.ambiguous_parts,
        payment_terms: paymentTerms,
        flags: rec.flags,
      },
    };
    const upd = await svc.from("orders")
      .update({
        result: newResult,
        quote_id: primary?.quote_id || order.quote_id || null,
        quote_number: primary?.quote_number || order.quote_number || null,
      })
      .eq("tenant_id", ctx.tenantId).eq("id", orderId);
    if (upd.error) throw new Error("orders update: " + upd.error.message);

    await recordAudit(ctx, {
      action: "order_reconcile_quotes", objectType: "order", objectId: orderId,
      detail: rec.summary.matched + "/" + rec.summary.total + " matched, " + rec.summary.price_mismatch + " price-mismatch, " + rec.summary.unmatched + " unmatched across " + rec.quotes_used.length + " quote(s)" + (paymentTerms.verdict === "mismatch" ? "; PAYMENT-TERMS MISMATCH (PO " + paymentTerms.po_terms + " vs quote " + paymentTerms.quote_terms + ")" : ""),
    });

    return json(res, 200, {
      order_id: orderId,
      summary: rec.summary,
      quotes_used: rec.quotes_used,
      ambiguous_parts: rec.ambiguous_parts,
      payment_terms: paymentTerms,
      flags: rec.flags,
      quotes_available: quotes.length,
    });
  } catch (err) {
    sendError(res, err);
  }
}
