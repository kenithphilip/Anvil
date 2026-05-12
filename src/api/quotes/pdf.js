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

// Pure-JS amount-in-words helper. The TS helper at
// src/v3-app/lib/amount-words.ts cannot be imported here because
// api/* runs on Vercel Node; this is a small duplicate of the
// international-numbering implementation. Pinned by the same
// vitest suite at amount-words.test.ts.
const _ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const _TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const _two = (n) => n < 20 ? _ONES[n] : (n % 10 === 0 ? _TENS[Math.floor(n / 10)] : _TENS[Math.floor(n / 10)] + " " + _ONES[n % 10]);
const _three = (n) => {
  const h = Math.floor(n / 100); const r = n % 100;
  return [h ? _ONES[h] + " Hundred" : "", r ? _two(r) : ""].filter(Boolean).join(" ");
};
const amountInWords = (raw, currency = "INR") => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v); const rupees = Math.floor(abs); const paise = Math.round((abs - rupees) * 100);
  const parts = []; const units = ["", "Thousand", "Million", "Billion"]; let rem = rupees; let i = 0;
  if (rem === 0) parts.push("Zero");
  while (rem > 0) {
    const c = rem % 1000;
    if (c > 0) parts.unshift(_three(c) + (units[i] ? " " + units[i] : ""));
    rem = Math.floor(rem / 1000); i++;
  }
  let out = (v < 0 ? "Minus " : "") + parts.join(" ");
  if (paise > 0) out += " and " + _two(paise) + " Paise";
  return out + " " + currency + " Only";
};

const buildPdfData = (tenant, order, customer, template) => {
  const so = order.result?.salesOrder || {};
  const items = Array.isArray(so.lineItems) ? so.lineItems : [];
  const grandTotal = so.grandTotal || so.total || items.reduce((s, ln) => s + (Number(ln.lineTotal) || Number(ln.amount) || 0), 0);
  return {
    number: order.quote_number || order.po_number || String(order.id || "").slice(0, 8),
    date: new Date(order.created_at || Date.now()).toLocaleDateString("en-US"),
    // Tenant-template-driven content (migration 106). Empty strings
    // when no template is set; the renderer falls back to its own
    // defaults so legacy quotes keep rendering.
    formCode: template?.form_code || null,
    standardMessage: template?.standard_message || null,
    warrantyClause: template?.warranty_clause || null,
    penaltyClause: template?.penalty_clause || null,
    cancellationClause: template?.cancellation_clause || null,
    forceMajeureClause: template?.force_majeure_clause || null,
    paymentTermsClause: template?.payment_terms_clause || null,
    deliveryTermsClause: template?.delivery_terms_clause || null,
    signatoryBlock: template?.signatory_block || null,
    footerBlock: template?.footer_block || null,
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
    items,
    subtotal: so.subtotal,
    tax: so.taxTotal || so.gstTotal,
    total: grandTotal,
    // Amount-in-words helper output. Mirrors the Tally SO PDF
    // convention and the helper-pinned tests.
    totalInWords: grandTotal ? amountInWords(grandTotal, so.currency || "INR") : null,
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
      .select("id, status, po_number, quote_number, result, customer_id, created_at, notes, template_id, quote_id")
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

    // Resolve the document template (migration 106). Precedence:
    //   1. The quote's explicit template_id if it carries one.
    //   2. The order's explicit template_id.
    //   3. The tenant's default template for doc_type=quotation.
    //   4. None (renderer falls back to its built-in copy).
    let template = null;
    try {
      let templateId = orderQ.data.template_id || null;
      if (!templateId && orderQ.data.quote_id) {
        const qt = await svc.from("quotes").select("template_id").eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.quote_id).maybeSingle();
        templateId = qt.data?.template_id || null;
      }
      if (templateId) {
        const t = await svc.from("document_templates").select("*").eq("tenant_id", ctx.tenantId).eq("id", templateId).maybeSingle();
        template = t.data || null;
      }
      if (!template) {
        const td = await svc.from("document_templates").select("*")
          .eq("tenant_id", ctx.tenantId).eq("doc_type", "quotation")
          .eq("is_default", true).eq("is_active", true)
          .maybeSingle();
        template = td.data || null;
      }
    } catch (_) {
      // Pre-migration-106 deployments: table does not exist. Renderer
      // falls back to its own defaults.
    }

    const pdfBuffer = await renderQuote(buildPdfData(tenant, orderQ.data, customer, template));

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
