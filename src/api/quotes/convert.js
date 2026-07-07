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

// Audit fix May 2026: prefer the canonical quote_lines table over
// the legacy quotes.line_items JSONB. Any quote edited via the
// QuoteDetailDrawer (post-108) writes to quote_lines, so reading
// JSONB silently dropped operator edits + every per-line tax
// component. Falls back to JSONB only when quote_lines has no
// rows for this quote (pre-108 quotes that pre-date the backfill).
export const buildSalesOrderFromLines = (quote, lineRows) => {
  const lineItems = (lineRows || []).map((ql, i) => {
    const qty = Number(ql.qty || 0);
    const rate = Number(ql.discounted_unit_price ?? ql.listed_unit_price ?? 0);
    return {
      line_no: ql.line_index != null ? ql.line_index + 1 : i + 1,
      partNumber: ql.part_no || null,
      itemName: ql.part_no || ql.description || null,
      description: ql.description || null,
      qty,
      rate,
      uom: ql.uom || null,
      hsn: ql.hsn_sac || null,
      // Per-line tax components survive the convert hop so the
      // resulting order's Tally push has the data it needs.
      cgst_pct: ql.cgst_pct != null ? Number(ql.cgst_pct) : null,
      sgst_pct: ql.sgst_pct != null ? Number(ql.sgst_pct) : null,
      igst_pct: ql.igst_pct != null ? Number(ql.igst_pct) : null,
      utgst_pct: ql.utgst_pct != null ? Number(ql.utgst_pct) : null,
      cess_pct: ql.cess_pct != null ? Number(ql.cess_pct) : null,
      // Mirror sum into gst_pct for code paths that read a single
      // rate (e.g. recon table, Tally composer).
      gst_pct: [ql.cgst_pct, ql.sgst_pct, ql.igst_pct, ql.utgst_pct]
        .map((v) => Number(v || 0))
        .reduce((a, b) => a + b, 0) || null,
      customer_part_number: ql.customer_part_number || null,
      source_country: ql.source_country || null,
      supplier_id: ql.supplier_id || null,
      discount_pct: ql.discount_pct != null ? Number(ql.discount_pct) : null,
      amount: Number(ql.line_amount ?? (qty * rate)),
    };
  });
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

const buildSalesOrderFromJsonb = (quote) => {
  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
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
    // Prefer quote_lines (post-108 canonical source) over the
    // legacy JSONB. Falls back when the table has no rows for
    // this quote (pre-108 quote that pre-dates the 109 backfill).
    const linesRes = await svc.from("quote_lines")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("quote_id", quote.id)
      .order("line_index", { ascending: true });
    const lineRows = (linesRes && !linesRes.error && Array.isArray(linesRes.data) && linesRes.data.length)
      ? linesRes.data
      : null;
    const result = lineRows
      ? buildSalesOrderFromLines(quote, lineRows)
      : buildSalesOrderFromJsonb(quote);

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
