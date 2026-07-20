// /api/receipts — customer GRN/SRN receipts (Delivery-to-Cash P0).
//   GET    ?invoice_id= | ?order_id= | ?customer_id= | ?status=   list (tenant-scoped)
//   POST   capture a receipt; auto-matches to an invoice (by invoice_number)
//          and an order (by po_number), inheriting order_id/customer_id
//   DELETE ?id=
// See docs/DELIVERY_TO_CASH_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { toIsoDate } from "../_lib/grn-extract.js";

const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const cleanNum = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const STATUSES = ["expected", "captured", "matched", "disputed"];
const SOURCES = ["email", "portal", "edi", "manual"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("customer_receipts").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.invoice_id) q = q.eq("invoice_id", req.query.invoice_id);
      if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.status) q = q.eq("status", req.query.status);
      const { data, error } = await q.order("captured_at", { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { receipts: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const receiptType = body.receipt_type === "SRN" ? "SRN" : "GRN";

      // The receipt_date is the payment clock and the column is a real date;
      // normalise (accepts ISO + day-first) and reject an unparseable one
      // rather than 500 on the insert.
      const receiptDate = body.receipt_date ? toIsoDate(body.receipt_date) : null;
      if (body.receipt_date && !receiptDate) {
        return json(res, 400, { error: { message: "receipt_date must be a real date (YYYY-MM-DD or DD/MM/YYYY)" } });
      }

      // A caller-supplied FK id must belong to THIS tenant — otherwise a body
      // id could link a receipt to another tenant's invoice/order/etc. (the
      // auto-match path below is already tenant-scoped). Mirrors credit_notes.
      const fkChecks = [
        ["invoice_id", "invoices"], ["einvoice_id", "einvoices"], ["order_id", "orders"],
        ["shipment_id", "shipments"], ["customer_id", "customers"],
        ["evidence_doc_id", "documents"], ["extraction_run_id", "extraction_runs"],
      ].filter(([f]) => body[f]);
      for (const [field, table] of fkChecks) {
        const chk = await svc.from(table).select("id")
          .eq("tenant_id", ctx.tenantId).eq("id", body[field]).limit(1).maybeSingle();
        if (chk.error || !chk.data) {
          return json(res, 400, { error: { message: `${field} not found in this tenant` } });
        }
      }

      const row = {
        tenant_id: ctx.tenantId,
        receipt_type: receiptType,
        receipt_number: cleanStr(body.receipt_number),
        receipt_date: receiptDate,
        po_number: cleanStr(body.po_number),
        invoice_number: cleanStr(body.invoice_number),
        invoice_id: body.invoice_id || null,
        einvoice_id: body.einvoice_id || null,
        order_id: body.order_id || null,
        shipment_id: body.shipment_id || null,
        customer_id: body.customer_id || null,
        posted_qty: cleanNum(body.posted_qty),
        short_qty: cleanNum(body.short_qty),
        rejected_qty: cleanNum(body.rejected_qty),
        source: SOURCES.includes(body.source) ? body.source : "manual",
        evidence_doc_id: body.evidence_doc_id || null,
        extraction_run_id: body.extraction_run_id || null,
        raw: body.raw && typeof body.raw === "object" ? body.raw : {},
        notes: cleanStr(body.notes),
        created_by: ctx.user?.id || null,
      };

      // Auto-match: invoice_number -> invoices, po_number -> orders. Inherit the
      // order/customer links so downstream AR aging can key off receipt_date.
      let matched = false;
      if (!row.invoice_id && row.invoice_number) {
        const inv = await svc.from("invoices").select("id, order_id, customer_id")
          .eq("tenant_id", ctx.tenantId).eq("invoice_number", row.invoice_number)
          .order("issue_date", { ascending: false }).limit(1).maybeSingle();
        if (!inv.error && inv.data) {
          row.invoice_id = inv.data.id;
          if (!row.order_id) row.order_id = inv.data.order_id || null;
          if (!row.customer_id) row.customer_id = inv.data.customer_id || null;
          matched = true;
        }
      }
      if (!row.order_id && row.po_number) {
        const ord = await svc.from("orders").select("id, customer_id")
          .eq("tenant_id", ctx.tenantId).eq("po_number", row.po_number)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (!ord.error && ord.data) {
          row.order_id = ord.data.id;
          if (!row.customer_id) row.customer_id = ord.data.customer_id || null;
          matched = true;
        }
      }
      row.status = STATUSES.includes(body.status)
        ? body.status
        : ((matched || row.invoice_id || row.order_id) ? "matched" : "captured");

      const ins = await svc.from("customer_receipts").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "customer_receipt_captured",
        objectType: "customer_receipt",
        objectId: ins.data.id,
        detail: `${receiptType} ${row.receipt_number || ""}`.trim(),
      });
      return json(res, 200, { receipt: ins.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("customer_receipts").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_receipt_deleted", objectType: "customer_receipt", objectId: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
