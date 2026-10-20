// GET /api/orders/so_pdf?orderId=<id>              -> application/pdf bytes
// GET /api/orders/so_pdf?orderId=<id>&format=share -> { url, expires_at }
//
// The Tally-style "SALES ORDER" acknowledgment PDF — the document the
// seller returns on receiving a customer PO (reproduces the Obara
// P250432276 layout). Distinct from voucher_pdf.js (the post-tax ERP
// sales voucher): body is ex-tax (Amount = Qty x Rate), with Cust Part
// No (buyer item no), Part No (vendor + its per-origin group marker), Due on, and a
// "Batch : <PO#>" sub-row per line. Line data comes from
// order.result.salesOrder.lineItems (populated by quote convert.js, or
// by the Link-Quote enrichment for PO-first orders).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";
import { hasUnresolvedBlocker, firstUnresolvedBlocker } from "../_lib/blocking-findings.js";
import { renderSalesOrderPdf } from "../_lib/so-document.js";

// The builder lives in _lib/so-document.js, so the handoff renders the same
// PDF. Re-exported for the callers and tests that import it from here.
export { partOriginMarker, PAYMENT_TERMS_NOT_STATED, decidedPaymentTerm, buildSalesOrderData } from "../_lib/so-document.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const orderId = req.query?.orderId;
    if (!orderId) return json(res, 400, { error: { message: "orderId required" } });
    const format = req.query?.format || "binary";
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      .select("id, status, rule_findings, po_number, po_date, quote_number, quote_id, result, customer_id, created_at, approved_at, dispatch_mode, registration_serial_no, delivery_terms, so_voucher_no, so_message, customer_location_id, delivery_point_contact_id, committed_delivery_date, dispatch_plan")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;

    // Rendering at any status is DELIBERATE — this is the acknowledgment a
    // seller returns on receiving a PO, not the post-tax voucher, and you
    // acknowledge an order before you approve it. Gating the PDF on APPROVED
    // would break the thing it is for.
    //
    // Sharing it is a different act. format=share uploads the PDF and mints a
    // SEVEN-DAY signed URL for a customer, so it is the one outward-facing
    // artefact this endpoint produces — and it was reachable on an order
    // carrying an unresolved blocking finding: a line count short of what the
    // PO declared, a total that does not reconcile, an extraction the operator
    // has not signed off. The same findings that stop approve, the Tally push
    // and the ERP runner. Sending the customer a document built on them is
    // worse than any of those, because it cannot be retracted.
    //
    // So: the internal download stays available at any status; the shareable
    // link does not.
    if (format === "share" && hasUnresolvedBlocker(order.rule_findings)) {
      const b = firstUnresolvedBlocker(order.rule_findings);
      return json(res, 409, {
        error: {
          code: "ORDER_HAS_UNRESOLVED_BLOCKER",
          message: "Cannot share this acknowledgment: unresolved blocking finding (" + b.code + "): "
            + (b.detail || "extraction incomplete")
            + " Resolve it first, or download the PDF for internal review.",
          finding: b,
        },
      });
    }

    const { pdf: pdfBuffer } = await renderSalesOrderPdf(svc, ctx.tenantId, order);

    if (format === "share") {
      let bucket;
      try { bucket = await ensureDocumentsBucket(svc); }
      catch (e) { bucket = documentsBucket(); console.warn("[orders/so_pdf] ensureDocumentsBucket: " + e.message); }
      const path = ctx.tenantId + "/sales_orders/" + orderId + ".pdf";
      const up = await svc.storage.from(bucket).upload(path, pdfBuffer, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error("storage upload: " + friendlyStorageError(up.error.message, bucket));
      const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
      if (signed.error) throw new Error("signed url: " + friendlyStorageError(signed.error.message, bucket));
      await recordAudit(ctx, { action: "so_pdf_shared", objectType: "order", objectId: orderId, detail: "ttl=" + SHARE_TTL_SECONDS + "s" });
      return json(res, 200, { url: signed.data.signedUrl, expires_at: new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString(), path, bucket });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="SO-' + (order.po_number || orderId.slice(0, 8)) + '.pdf"');
    res.setHeader("Content-Length", String(pdfBuffer.length));
    await recordAudit(ctx, { action: "so_pdf_downloaded", objectType: "order", objectId: orderId, detail: "bytes=" + pdfBuffer.length });
    return res.end(pdfBuffer);
  } catch (err) {
    sendError(res, err);
  }
}
