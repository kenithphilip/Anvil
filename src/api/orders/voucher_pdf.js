// GET /api/orders/voucher_pdf?orderId=<id>              -> application/pdf bytes
// GET /api/orders/voucher_pdf?orderId=<id>&format=share -> { url, expires_at }
//
// The ERP-format sales-order voucher PDF — the post-approval document
// that completes the lead → opp → quote → SO → approved → voucher chain.
// Distinct from the quote PDF (src/api/quotes/pdf.js): this renders a
// Tally sales-voucher layout (HSN per line, CGST/SGST vs IGST split by
// place of supply, seller + party GSTIN/state) so the printed voucher
// matches what the Tally XML push (tally-build-voucher.js) sends to the
// ERP. Reuses that module's tax helpers as the single source of truth.
//
// Gated to approved-and-beyond orders: a draft has no voucher.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderVoucher } from "../_lib/pdf-renderer.js";
import { amountInWords } from "../_lib/amount-words.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";
import { tallyResolveCompany } from "../_lib/tally-client.js";
import { resolveSalesVoucherType } from "../_lib/tally-voucher-type.js";
import { computeLineTax, placeOfSupplyKind, sellerStateCode, buyerStateCode } from "../_lib/tally-build-voucher.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// A voucher only exists once the SO is approved (or further along).
const VOUCHER_STATUSES = new Set([
  "APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED",
]);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pick = (...vals) => vals.find((v) => v != null && v !== "");

const buildVoucherData = ({ tenant, order, customer, company, voucherType }) => {
  const so = order.result?.salesOrder || {};
  const soItems = Array.isArray(so.lineItems) ? so.lineItems : [];
  const kind = placeOfSupplyKind(company, customer); // 'intrastate' | 'interstate'

  let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  const items = soItems.map((ln) => {
    const t = computeLineTax({
      qty: pick(ln.qty, ln.quantity),
      rate: pick(ln.discounted_unit_price, ln.unit_price, ln.rate, ln.unitPrice),
      gst_pct: pick(ln.gst_pct, ln.gstRate, ln.rate_of_duty_pct),
      cess_pct: ln.cess_pct,
    }, kind);
    taxable += t.taxable; cgst += t.cgst; sgst += t.sgst; igst += t.igst; cess += t.cess;
    return {
      partNumber: pick(ln.part_no, ln.partNumber, ln.itemCode) || null,
      description: pick(ln.description, ln.itemName) || null,
      hsn: pick(ln.hsn, ln.hsn_sac) || null,
      quantity: pick(ln.qty, ln.quantity),
      uom: pick(ln.uom, ln.unit) || null,
      rate: pick(ln.discounted_unit_price, ln.unit_price, ln.rate, ln.unitPrice),
      gstPct: t.gst_pct,
      taxable: t.taxable,
    };
  });

  taxable = round2(taxable); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst); cess = round2(cess);
  const total = round2(taxable + cgst + sgst + igst + cess);
  const currency = so.currency || "INR";

  return {
    number: pick(order.po_number, order.quote_number, String(order.id || "").slice(0, 8)),
    date: new Date(order.approved_at || order.created_at || Date.now()).toLocaleDateString("en-US"),
    brand: {
      name: company?.name || tenant?.display_name || "Anvil",
      tagline: tenant?.tagline || null,
      address: company?.address || tenant?.billing_address || null,
    },
    from: {
      name: company?.name || tenant?.display_name || "Anvil",
      line2: company?.address || tenant?.billing_address || null,
      gstin: company?.gstin || null,
      state: sellerStateCode(company),
    },
    to: {
      name: pick(customer?.customer_name, customer?.name) || "Customer",
      line2: customer?.billing_address || null,
      gstin: customer?.gstin || null,
      state: buyerStateCode(customer),
    },
    voucherType: voucherType || "Sales",
    poRef: order.po_number || null,
    placeOfSupply: kind === "intrastate" ? "Intrastate (CGST + SGST)" : "Interstate (IGST)",
    items,
    taxable, cgst, sgst, igst, cess,
    total,
    currency,
    totalInWords: total ? amountInWords(total, { currency, style: "indian" }) : null,
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
    const orderQ = await svc.from("orders")
      .select("id, status, po_number, quote_number, result, customer_id, created_at, approved_at, notes")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;

    if (!VOUCHER_STATUSES.has(order.status)) {
      return json(res, 409, {
        error: {
          code: "NOT_APPROVED",
          message: "The ERP voucher is available once the sales order is approved. Current status: " + order.status + ".",
        },
      });
    }

    let customer = null;
    if (order.customer_id) {
      const cQ = await svc.from("customers")
        .select("customer_name, contact_email, gstin, state_code, billing_address")
        .eq("tenant_id", ctx.tenantId).eq("id", order.customer_id).maybeSingle();
      if (!cQ.error) customer = cQ.data;
    }
    const tenantQ = await svc.from("tenants").select("display_name, slug").eq("id", ctx.tenantId).maybeSingle();
    const tenant = tenantQ.data || null;

    // Seller company (GSTIN, state, voucher type). Best-effort: v1
    // tenants without a tally_companies row fall back to interstate
    // (the conservative default placeOfSupplyKind already applies).
    let company = null;
    let voucherType = "Sales";
    try {
      company = await tallyResolveCompany(svc, ctx.tenantId, null);
      voucherType = resolveSalesVoucherType(company) || "Sales";
    } catch (_) { /* no tally_companies table / row */ }

    const data = buildVoucherData({ tenant, order, customer, company, voucherType });
    const pdfBuffer = await renderVoucher(data);

    if (format === "share") {
      let bucket;
      try { bucket = await ensureDocumentsBucket(svc); }
      catch (e) { bucket = documentsBucket(); console.warn("[orders/voucher_pdf] ensureDocumentsBucket: " + e.message); }
      const path = ctx.tenantId + "/vouchers/" + orderId + ".pdf";
      const up = await svc.storage.from(bucket).upload(path, pdfBuffer, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error("storage upload: " + friendlyStorageError(up.error.message, bucket));
      const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
      if (signed.error) throw new Error("signed url: " + friendlyStorageError(signed.error.message, bucket));
      const expiresAt = new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString();
      await recordAudit(ctx, {
        action: "so_voucher_pdf_shared", objectType: "order", objectId: orderId,
        detail: "ttl=" + SHARE_TTL_SECONDS + "s",
      });
      return json(res, 200, { url: signed.data.signedUrl, expires_at: expiresAt, path, bucket });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
      'inline; filename="voucher-' + (order.po_number || order.quote_number || orderId.slice(0, 8)) + '.pdf"');
    res.setHeader("Content-Length", String(pdfBuffer.length));
    await recordAudit(ctx, {
      action: "so_voucher_pdf_downloaded", objectType: "order", objectId: orderId,
      detail: "bytes=" + pdfBuffer.length,
    });
    return res.end(pdfBuffer);
  } catch (err) {
    sendError(res, err);
  }
}
