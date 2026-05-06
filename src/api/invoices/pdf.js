// GET /api/invoices/pdf?id=<invoice_id>
//
// Renders the invoice PDF using the shared _lib/pdf-renderer.js
// (kind="Invoice"). Mirrors /api/quotes/pdf so the operator UX is
// consistent across both artifacts.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderInvoice } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

const buildInvoicePdfData = (tenant, invoice, customer) => ({
  number: invoice.invoice_number,
  date: invoice.issue_date,
  brand: {
    name: tenant?.display_name || "Anvil",
    address: tenant?.billing_address || null,
  },
  from: {
    name: tenant?.display_name || "Anvil",
    line2: tenant?.billing_address || null,
    gstin: tenant?.gstin || null,
  },
  to: {
    name: customer?.customer_name || "Customer",
    line2: customer?.billing_address || null,
    email: customer?.contact_email || null,
    gstin: customer?.gstin || null,
  },
  items: Array.isArray(invoice.line_items) ? invoice.line_items : [],
  subtotal: invoice.subtotal,
  tax: invoice.tax_total,
  total: invoice.grand_total,
  currency: invoice.currency,
  notes: invoice.notes || ("Payment terms: " + (invoice.payment_terms || "Net 30") + ". Due " + invoice.due_date + "."),
});

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
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: { message: "id required" } });
    const format = req.query?.format || "binary";

    const svc = serviceClient();
    const invQ = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (invQ.error) throw new Error("invoices read: " + invQ.error.message);
    if (!invQ.data) return json(res, 404, { error: { message: "Invoice not found" } });

    let customer = null;
    if (invQ.data.customer_id) {
      const cQ = await svc.from("customers")
        .select("customer_name, contact_email, gstin, billing_address")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", invQ.data.customer_id)
        .maybeSingle();
      if (!cQ.error) customer = cQ.data;
    }
    const tQ = await svc.from("tenants").select("display_name, slug").eq("id", ctx.tenantId).maybeSingle();
    const tenant = tQ.data || null;

    const pdf = await renderInvoice(buildInvoicePdfData(tenant, invQ.data, customer));

    if (format === "share") {
      let bucket;
      try { bucket = await ensureDocumentsBucket(svc); }
      catch (e) {
        bucket = documentsBucket();
        // eslint-disable-next-line no-console
        console.warn("[invoices/pdf] ensureDocumentsBucket: " + e.message);
      }
      const path = ctx.tenantId + "/invoices/" + id + ".pdf";
      const up = await svc.storage.from(bucket).upload(path, pdf, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error("storage upload: " + friendlyStorageError(up.error.message, bucket));
      const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
      if (signed.error) throw new Error("signed url: " + friendlyStorageError(signed.error.message, bucket));
      // Persist the PDF path on the invoice for later reuse.
      await svc.from("invoices").update({ pdf_storage_path: path }).eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "invoice_pdf_shared", objectType: "invoice", objectId: id });
      return json(res, 200, {
        url: signed.data.signedUrl,
        expires_at: new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString(),
        path, bucket,
      });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="invoice-' + invQ.data.invoice_number + '.pdf"');
    res.setHeader("Content-Length", String(pdf.length));
    await recordAudit(ctx, { action: "invoice_pdf_downloaded", objectType: "invoice", objectId: id });
    return res.end(pdf);
  } catch (err) {
    sendError(res, err);
  }
}
