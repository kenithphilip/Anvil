// GET /api/quotes/pdf?orderId=<id>             -> application/pdf bytes
// GET /api/quotes/pdf?orderId=<id>&format=share -> { url, expires_at }
//
// Renders a branded PDF of the quote attached to the given order.
// The order's result.salesOrder is the canonical extraction; we
// pull customer details and tenant brand info to fill in the rest.
//
// `format=share` writes the PDF to Supabase Storage at
// <tenant_id>/quotes/<order_id>.pdf, regenerates a 7-day signed URL,
// records a quote_pdf_shared audit event, and returns the URL.
// Useful for sending to customers via the comms.send pipeline; the
// share URL is stable for the TTL.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderQuote } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const buildPdfData = (tenant, order, customer) => {
  const so = order.result?.salesOrder || {};
  return {
    number: order.quote_number || order.po_number || String(order.id || "").slice(0, 8),
    date: new Date(order.created_at || Date.now()).toLocaleDateString("en-US"),
    brand: {
      name: tenant?.display_name || "Anvil",
      tagline: tenant?.tagline || null,
      address: tenant?.billing_address || null,
    },
    from: {
      name: tenant?.display_name || "Anvil",
      line2: tenant?.billing_address || null,
      gstin: tenant?.gstin || null,
    },
    to: {
      name: customer?.customer_name || customer?.name || "Customer",
      line2: customer?.billing_address || null,
      email: customer?.contact_email || null,
      gstin: customer?.gstin || null,
    },
    items: Array.isArray(so.lineItems) ? so.lineItems : [],
    subtotal: so.subtotal,
    tax: so.taxTotal || so.gstTotal,
    total: so.grandTotal || so.total,
    currency: so.currency || "USD",
    notes: so.notes || order.notes || null,
  };
};

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
    const orderQ = await svc
      .from("orders")
      .select("id, status, po_number, quote_number, result, customer_id, created_at, notes")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", orderId)
      .maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });

    let customer = null;
    if (orderQ.data.customer_id) {
      const cQ = await svc
        .from("customers")
        .select("customer_name, customer_key, contact_email, gstin, billing_address")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", orderQ.data.customer_id)
        .maybeSingle();
      if (!cQ.error) customer = cQ.data;
    }
    const tenantQ = await svc
      .from("tenants")
      .select("display_name, slug")
      .eq("id", ctx.tenantId)
      .maybeSingle();
    const tenant = tenantQ.data || null;

    const pdfBuffer = await renderQuote(buildPdfData(tenant, orderQ.data, customer));

    if (format === "share") {
      // Upload (overwrite) so the same orderId always resolves to the
      // latest quote bytes. Then regenerate a signed URL.
      let bucket;
      try { bucket = await ensureDocumentsBucket(svc); }
      catch (e) {
        bucket = documentsBucket();
        // eslint-disable-next-line no-console
        console.warn("[quotes/pdf] ensureDocumentsBucket: " + e.message);
      }
      const path = ctx.tenantId + "/quotes/" + orderId + ".pdf";
      const up = await svc.storage.from(bucket).upload(path, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (up.error) throw new Error("storage upload: " + friendlyStorageError(up.error.message, bucket));
      const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
      if (signed.error) throw new Error("signed url: " + friendlyStorageError(signed.error.message, bucket));
      const expiresAt = new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString();
      await recordAudit(ctx, {
        action: "quote_pdf_shared",
        objectType: "order",
        objectId: orderId,
        detail: "ttl=" + SHARE_TTL_SECONDS + "s",
      });
      return json(res, 200, {
        url: signed.data.signedUrl,
        expires_at: expiresAt,
        path,
        bucket,
      });
    }

    // Binary stream
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="quote-' + (orderQ.data.quote_number || orderQ.data.po_number || orderId.slice(0, 8)) + '.pdf"'
    );
    res.setHeader("Content-Length", String(pdfBuffer.length));
    await recordAudit(ctx, {
      action: "quote_pdf_downloaded",
      objectType: "order",
      objectId: orderId,
      detail: "bytes=" + pdfBuffer.length,
    });
    return res.end(pdfBuffer);
  } catch (err) {
    sendError(res, err);
  }
}
