// /api/invoices
//
// GET  list invoices for the tenant. Filters: status, customer_id,
//      from, to, order_id, paginated via limit + offset.
// POST create an invoice. Body: { order_id, due_date?, notes?,
//      payment_terms?, line_items?, currency?, net_days? }.
//      Allocates an invoice_number atomically via next_invoice_number.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { nextInvoiceNumber, invoiceFromOrder } from "../_lib/invoicing.js";

const VALID_STATUS = new Set(["draft", "sent", "partial", "paid", "overdue", "void"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId);
      const status = req.query?.status;
      if (status && VALID_STATUS.has(status)) q = q.eq("status", status);
      if (req.query?.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query?.order_id) q = q.eq("order_id", req.query.order_id);
      if (req.query?.from) q = q.gte("issue_date", req.query.from);
      if (req.query?.to)   q = q.lte("issue_date", req.query.to);
      const limit = Math.min(Number(req.query?.limit) || 200, 500);
      const offset = Math.max(Number(req.query?.offset) || 0, 0);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw new Error(error.message);
      return json(res, 200, { invoices: data || [], limit, offset });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.order_id) {
        return json(res, 400, { error: { message: "order_id required" } });
      }
      const orderQ = await svc
        .from("orders")
        .select("id, status, customer_id, result, po_number, quote_number, created_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", body.order_id)
        .maybeSingle();
      if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
      if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });

      const draft = invoiceFromOrder(orderQ.data, body);
      // Allow caller to override line_items + totals (e.g. partial
      // invoicing on a multi-shipment order).
      if (Array.isArray(body.line_items)) {
        draft.line_items = body.line_items;
        draft.subtotal = body.subtotal != null ? Number(body.subtotal) : draft.subtotal;
        draft.tax_total = body.tax_total != null ? Number(body.tax_total) : draft.tax_total;
        draft.grand_total = body.grand_total != null ? Number(body.grand_total) : draft.grand_total;
      }
      if (body.payment_terms) draft.payment_terms = body.payment_terms;
      if (body.notes) draft.notes = body.notes;
      if (body.currency) draft.currency = body.currency;

      const invoice_number = await nextInvoiceNumber(svc, ctx.tenantId);
      const ins = await svc.from("invoices").insert({
        tenant_id: ctx.tenantId,
        invoice_number,
        created_by: ctx.user?.id || null,
        ...draft,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);

      await recordAudit(ctx, {
        action: "invoice_create",
        objectType: "invoice",
        objectId: ins.data.id,
        detail: invoice_number + " :: " + (draft.grand_total || 0) + " " + (draft.currency || "USD"),
      });
      await recordEvent(ctx, {
        caseId: orderQ.data.id,
        eventType: "invoice_created",
        objectType: "invoice",
        objectId: ins.data.id,
      });
      return json(res, 200, { invoice: ins.data });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
