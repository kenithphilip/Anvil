// POST /api/quotes/convert
// Body: { id, order_mode? }
//
// Audit P6.4. Converts an ACCEPTED quote to a sales order.
// Operators used to copy line items + customer + currency by
// hand; the new endpoint:
//
//   1. Validates the quote is ACCEPTED (or DRAFT/SENT for
//      operator-driven manual conversion).
//   2. Builds the orders row with status=DRAFT, customer_id and
//      currency from the quote, lineItems mapped into the
//      orders.result.salesOrder shape.
//   3. Sets orders.quote_id (FK back to the source quote).
//   4. Flips the quote to CONVERTED with converted_order_id +
//      converted_at populated.
//
// The new order is intentionally DRAFT so the operator can run
// the existing approval + push flow on top. The quote's
// payload_hash carries forward as orders.payload_hash so the
// approval gate recognises the source.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const VALID_ORDER_MODES = new Set(["SPARES", "SPARES_ASSEMBLY", "PROJECT_FOR", "PROJECT_HSS", "INTERNAL"]);

const buildSalesOrder = (quote) => {
  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
  // Normalise the line shape so the existing renderers (PDF,
  // Tally push, anomaly engine) read familiar field names.
  const lineItems = items.map((li, i) => ({
    line_no: li.line_no || (i + 1),
    partNumber: li.partNumber || li.partNo || li.sellerPartNo || null,
    itemName: li.itemName || li.tallyItemName || li.partNumber || null,
    description: li.description || null,
    qty: Number(li.quantity || li.qty || 0),
    rate: Number(li.unitPrice || li.rate || 0),
    uom: li.uom || null,
    hsn: li.hsn || li.hsnCode || null,
    amount: Number(li.quantity || li.qty || 0) * Number(li.unitPrice || li.rate || 0),
  }));
  return {
    salesOrder: {
      lineItems,
      currency: quote.currency || "INR",
      subtotal: quote.subtotal,
      taxTotal: quote.tax_total,
      grandTotal: quote.grand_total,
    },
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id required" } });

    const svc = serviceClient();
    const qQ = await svc.from("quotes").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (qQ.error) throw new Error("quotes read: " + qQ.error.message);
    if (!qQ.data) return json(res, 404, { error: { message: "Quote not found" } });
    const quote = qQ.data;
    // Operator-driven manual conversion is allowed from ACCEPTED
    // (the standard happy path) and from DRAFT/SENT (explicit
    // operator override; the audit row records the bypass).
    if (!["ACCEPTED", "DRAFT", "SENT"].includes(quote.status)) {
      return json(res, 409, {
        error: { message: "Cannot convert a quote in status " + quote.status },
      });
    }

    const orderMode = body.order_mode && VALID_ORDER_MODES.has(body.order_mode) ? body.order_mode : null;
    const result = buildSalesOrder(quote);

    const insOrder = await svc.from("orders").insert({
      tenant_id: ctx.tenantId,
      customer_id: quote.customer_id || null,
      status: "DRAFT",
      quote_id: quote.id,
      quote_number: quote.quote_number,
      quote_date: quote.created_at ? quote.created_at.slice(0, 10) : null,
      order_mode: orderMode,
      result,
      payload_hash: quote.payload_hash || null,
      preflight_payload: {
        source: "quote_convert",
        quote_id: quote.id,
        quote_version: quote.version,
        accepted_at: quote.accepted_at,
      },
    }).select("*").single();
    if (insOrder.error) throw new Error("orders insert: " + insOrder.error.message);

    const newOrder = insOrder.data;

    // Flip the quote to CONVERTED. Use the lifecycle PATCH path
    // shape so any future change to allowed_transitions catches
    // a stale converter.
    const upd = await svc.from("quotes").update({
      status: "CONVERTED",
      converted_at: new Date().toISOString(),
      converted_order_id: newOrder.id,
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", ctx.tenantId).eq("id", quote.id).select("*").single();
    if (upd.error) throw new Error("quote CONVERTED update: " + upd.error.message);

    await recordAudit(ctx, {
      action: "quote_convert",
      objectType: "quote",
      objectId: quote.id,
      detail: "order=" + newOrder.id + " ref=" + (quote.quote_number || quote.id),
      payloadHash: quote.payload_hash || null,
      after: { converted_order_id: newOrder.id, prior_status: quote.status },
    });
    await recordEvent(ctx, {
      caseId: newOrder.id,
      eventType: "order_from_quote",
      objectType: "order",
      objectId: newOrder.id,
      detail: { quote_id: quote.id, quote_version: quote.version },
    });

    return json(res, 200, {
      ok: true,
      order: newOrder,
      quote: upd.data,
    });
  } catch (err) { sendError(res, err); }
}
