// GET /api/orders/so_pdf?orderId=<id>              -> application/pdf bytes
// GET /api/orders/so_pdf?orderId=<id>&format=share -> { url, expires_at }
//
// The Tally-style "SALES ORDER" acknowledgment PDF — the document the
// seller returns on receiving a customer PO (reproduces the Obara
// P250432276 layout). Distinct from voucher_pdf.js (the post-tax ERP
// sales voucher): body is ex-tax (Amount = Qty x Rate), with Cust Part
// No (buyer item no), Part No (vendor + "(O/K)"), Due on, and a
// "Batch : <PO#>" sub-row per line. Line data comes from
// order.result.salesOrder.lineItems (populated by quote convert.js, or
// by the Link-Quote enrichment for PO-first orders).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderSalesOrder } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const OK_SUFFIX = "(O/K)"; // fixed Obara marker appended to every vendor part on the SO
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pick = (...vals) => vals.find((v) => v != null && v !== "");

// Tally-style short date, e.g. "23-Apr-25".
const fmtDate = (d) => {
  const dt = d ? new Date(d) : null;
  if (!dt || isNaN(dt.getTime())) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getMonth()];
  return String(dt.getDate()).padStart(2, "0") + "-" + mon + "-" + String(dt.getFullYear()).slice(-2);
};

const addrLines = (...parts) => parts.map((p) => (p == null ? "" : String(p).trim())).filter(Boolean);

const buildSalesOrderData = ({ order, customer, consigneeLoc, seller, contact, schedules }) => {
  const soData = order.result?.salesOrder || {};
  const soItems = Array.isArray(soData.lineItems) ? soData.lineItems : [];
  const dueByIndex = new Map((schedules || []).map((s) => [Number(s.line_index), s.scheduled_date]));

  const items = soItems.map((ln, i) => {
    const partNo = pick(ln.part_no, ln.partNumber, ln.itemCode) || "";
    const qty = Number(pick(ln.qty, ln.quantity)) || 0;
    const rate = Number(pick(ln.discounted_unit_price, ln.unit_price, ln.rate, ln.unitPrice)) || 0;
    const discPct = ln.discount_pct != null ? Number(ln.discount_pct) : null;
    return {
      sl: i + 1,
      description: pick(ln.description, ln.itemName) || "—",
      hsn: pick(ln.hsn, ln.hsn_sac) || "",
      custPartNo: pick(ln.customer_part_number, ln.cust_part_no, ln.customerPartNumber) || "",
      partNo: partNo ? partNo + OK_SUFFIX : "",
      dueOn: fmtDate(dueByIndex.get(i) || soData.delivery_date || null),
      qty,
      uom: pick(ln.uom, ln.unit) || "No.",
      rate,
      disc: discPct != null ? (discPct <= 1 ? round2(discPct * 100) : round2(discPct)) : "",
      amount: round2(qty * rate),
      batch: order.po_number || "",
    };
  });

  const buyer = {
    name: pick(customer?.customer_name, customer?.name) || "Customer",
    addressLines: addrLines(customer?.billing_address),
    gstin: customer?.gstin || null,
    stateName: customer?.state_name || null,
    stateCode: customer?.state_code || null,
  };
  const consignee = consigneeLoc ? {
    name: pick(consigneeLoc.location_name, consigneeLoc.name, buyer.name),
    addressLines: addrLines(consigneeLoc.address_line1, consigneeLoc.address_line2, consigneeLoc.city, consigneeLoc.pincode ? "PIN " + consigneeLoc.pincode : null),
    gstin: consigneeLoc.gstin || buyer.gstin,
    stateName: buyer.stateName,
    stateCode: consigneeLoc.state_code || buyer.stateCode,
  } : buyer;

  return {
    voucherNo: order.so_voucher_no || "",
    dated: fmtDate(order.approved_at || order.created_at),
    modeOfPayment: pick(customer?.default_payment_terms, "30 Days"),
    buyerRef: order.po_number || "",
    regSerialNo: order.registration_serial_no || "",
    dispatchedThrough: order.dispatch_mode || "By Road",
    destination: consignee.stateName || "",
    termsOfDelivery: order.delivery_terms || "",
    contactPerson: contact ? pick(contact.name, contact.contact_name) || "" : "",
    contactPhone: contact ? pick(contact.phone, contact.mobile) || "" : "",
    message: order.so_message || null,
    currency: soData.currency || "INR",
    seller: {
      name: seller?.legal_name || seller?.trade_name || "—",
      addressLines: addrLines(seller?.address1, seller?.address2, seller?.locality, seller?.pincode ? "PIN " + seller.pincode : null),
      gstin: seller?.gstin || null,
      stateName: seller?.state_name || null,
      stateCode: seller?.state_code || null,
      cin: seller?.cin || null,
      email: seller?.email || null,
      pan: seller?.pan || null,
    },
    consignee,
    buyer,
    items,
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
      .select("id, status, po_number, po_date, quote_number, quote_id, result, customer_id, created_at, approved_at, dispatch_mode, registration_serial_no, delivery_terms, so_voucher_no, so_message, customer_location_id, delivery_point_contact_id")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;

    let customer = null;
    if (order.customer_id) {
      const cQ = await svc.from("customers")
        .select("customer_name, gstin, state_code, billing_address, default_payment_terms")
        .eq("tenant_id", ctx.tenantId).eq("id", order.customer_id).maybeSingle();
      if (!cQ.error) customer = cQ.data;
    }
    // Consignee (ship-to) + contact person — best-effort (columns/tables may vary).
    let consigneeLoc = null;
    if (order.customer_location_id) {
      try {
        const lQ = await svc.from("customer_locations").select("*").eq("tenant_id", ctx.tenantId).eq("id", order.customer_location_id).maybeSingle();
        if (!lQ.error) consigneeLoc = lQ.data;
      } catch (_) { /* optional */ }
    }
    let contact = null;
    if (order.delivery_point_contact_id) {
      try {
        const kQ = await svc.from("customer_contacts").select("*").eq("tenant_id", ctx.tenantId).eq("id", order.delivery_point_contact_id).maybeSingle();
        if (!kQ.error) contact = kQ.data;
      } catch (_) { /* optional */ }
    }
    // Seller identity from tenant_settings.einvoice_seller_* (+ cin/pan).
    let seller = null;
    try {
      const sQ = await svc.from("tenant_settings")
        .select("einvoice_seller_legal_name, einvoice_seller_trade_name, einvoice_seller_gstin, einvoice_seller_address_line1, einvoice_seller_address_line2, einvoice_seller_locality, einvoice_seller_pincode, einvoice_seller_state_code, einvoice_seller_email, cin, pan")
        .eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!sQ.error && sQ.data) {
        const s = sQ.data;
        seller = {
          legal_name: s.einvoice_seller_legal_name, trade_name: s.einvoice_seller_trade_name,
          gstin: s.einvoice_seller_gstin, address1: s.einvoice_seller_address_line1, address2: s.einvoice_seller_address_line2,
          locality: s.einvoice_seller_locality, pincode: s.einvoice_seller_pincode, state_code: s.einvoice_seller_state_code,
          email: s.einvoice_seller_email, cin: s.cin, pan: s.pan,
        };
      }
    } catch (_) { /* pre-062/pre-so-migration tenants */ }
    // Per-line due dates.
    let schedules = [];
    try {
      const schQ = await svc.from("order_schedule_lines").select("line_index, scheduled_date").eq("tenant_id", ctx.tenantId).eq("order_id", orderId);
      if (!schQ.error) schedules = schQ.data || [];
    } catch (_) { /* optional */ }

    const data = buildSalesOrderData({ order, customer, consigneeLoc, seller, contact, schedules });
    const pdfBuffer = await renderSalesOrder(data);

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
