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
import { renderSalesOrder } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";
import { classifyOrigin } from "../_lib/pending-so/part-origin.js";
import { hasUnresolvedBlocker, firstUnresolvedBlocker } from "../_lib/blocking-findings.js";
import { soLineMoney } from "../_lib/so-line-money.js";
import { lineDueDate, fmtDueDate } from "../_lib/order-delivery-date.js";
import { readTermsCheckMode } from "../_lib/terms/mode.js";
import { readCurrentCheck, readFlags } from "../_lib/terms/check.js";
import { readDecisions, historyByFlag } from "../_lib/terms/decisions.js";
import { normalizeWording } from "../_lib/terms/compare.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Obara group-origin marker appended to a vendor part on the SO PDF. This was a
// hardcoded "(O/K)" on EVERY part, which mislabelled locally-made -I parts and
// China/Japan imports as Korea. Derive it per part instead: prefer the
// item-master-resolved source_country, else classify from the part/description
// strings (pending-so/part-origin). A locally-made part already carries its own
// "-I" suffix so nothing is appended; an unclassifiable part gets NO marker
// rather than a wrong guess.
const SOURCE_COUNTRY_MARKER = {
  "O-KOREA": "(O/K)", "O-CHINA": "(O/C)", "O-JAPAN": "(O/J)",
  "O-THAILAND": "(O/T)", "O-FRANCE": "(O/F)",
};
export const partOriginMarker = (line, partNo, description) => {
  // Don't double-mark a part that already carries an origin marker.
  if (/-I$/i.test(String(partNo || "")) || /\(\s*O\s*\//i.test(String(partNo || ""))) return "";
  // 1. Item-master resolved origin (stamped by mapLinesToItemMaster) wins.
  const mapped = line?._mapped_item?.source_country || line?.source_country || null;
  if (mapped) return SOURCE_COUNTRY_MARKER[mapped] || ""; // O-INDIA / unknown vocab -> no marker
  // 2. Else classify from the strings; only an import gets an (O/x) marker.
  const v = classifyOrigin({ part_no: partNo, description });
  return (v.origin === "import" && SOURCE_COUNTRY_MARKER[v.source_country]) || "";
};

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

const text = (v) => (v == null ? "" : String(v).trim());
const firstText = (...vals) => vals.map(text).find(Boolean) || "";

// Printed when no source states the payment terms. This used to be a literal
// "30 Days", a term no document had said.
export const PAYMENT_TERMS_NOT_STATED = "Not stated";

// The payment term a decision on the terms check settled on (migration 250),
// or null when no decision has settled one. `flags` are the current check's
// order_term_flags, `history` is historyByFlag of their decisions.
//   accept, not_a_deviation  the PO's wording, else the quote's when the PO
//                            was silent
//   reject_term              our quote's wording, and the PO's is refused, so
//                            the PDF never falls back to it
//   request_amendment        still open, and we have asked the customer to
//                            change the PO's term: our quote's wording, and
//                            the PO's is not printed, so the acknowledgment
//                            does not confirm the term we asked them to amend
// poText is the PO's wording that is out, so a customer default worded the
// same is not printed in its place. With several quotes, the primary quote's
// flag is read first.
export const decidedPaymentTerm = (flags, history) => {
  const list = (flags || []).filter((f) => f && f.clause === "payment_terms" && !f.superseded_at)
    .sort((a, b) => (a.quote?.primary ? 0 : 1) - (b.quote?.primary ? 0 : 1));
  for (const f of list) {
    const current = (history?.get(f.id) || [])[0];
    if (!current) continue;
    if (current.decision === "accept" || current.decision === "not_a_deviation") {
      return { text: firstText(f.po?.text, f.quote?.text) || null, poRefused: false, amendmentOpen: false, poText: null };
    }
    if (current.decision === "reject_term" || current.decision === "request_amendment") {
      return {
        text: text(f.quote?.text) || null,
        poRefused: current.decision === "reject_term",
        amendmentOpen: current.decision === "request_amendment",
        poText: text(f.po?.text) || null,
      };
    }
  }
  return null;
};

// Exported for tests, so the line money can be checked against the Excel
// export without rendering a PDF. decidedTerm is decidedPaymentTerm's result.
export const buildSalesOrderData = ({ order, customer, consigneeLoc, seller, contact, schedules, decidedTerm = null }) => {
  const soData = order.result?.salesOrder || {};
  const soItems = Array.isArray(soData.lineItems) ? soData.lineItems : [];

  const items = soItems.map((ln, i) => {
    const partNo = pick(ln.part_no, ln.partNumber, ln.itemCode) || "";
    // The PO's rate, from the helper the Excel export reads too. This used to
    // read discounted_unit_price first, which the reconciler had set to the
    // QUOTE's rate, so the PDF and the Excel disagreed on a reconciled line.
    const { qty, rate, amount } = soLineMoney(ln);
    const discPct = ln.discount_pct != null ? Number(ln.discount_pct) : null;
    return {
      sl: i + 1,
      description: pick(ln.description, ln.itemName) || "—",
      hsn: pick(ln.hsn, ln.hsn_sac) || "",
      custPartNo: pick(ln.customer_part_number, ln.cust_part_no, ln.customerPartNumber) || "",
      partNo: partNo ? partNo + partOriginMarker(ln, partNo, pick(ln.description, ln.itemName)) : "",
      // Our schedule, else the PO line's date, else the PO header's, else the
      // date we committed to (order-delivery-date.js lineDueDate). The Excel
      // export prints the same date from the same helper.
      dueOn: fmtDueDate(lineDueDate(order, i, schedules)),
      qty,
      uom: pick(ln.uom, ln.unit) || "No.",
      rate,
      disc: discPct != null ? (discPct <= 1 ? round2(discPct * 100) : round2(discPct)) : "",
      amount,
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

  // Payment terms, in this order: the term a decision settled on, the PO's
  // own terms as extracted, the customer's default, else "Not stated". The
  // PO's terms are where the reconciler and the terms check read them. A PO
  // term that was refused, or that we asked the customer to amend, is not
  // printed, and neither is a customer default worded the same way (as the
  // terms check compares wording, sides.js), since that is the same term.
  const extractedPoTerms = firstText(soData.customer?.payment_terms, soData.payment_terms);
  const poOut = !!(decidedTerm?.poRefused || decidedTerm?.amendmentOpen);
  const poTerms = poOut ? "" : extractedPoTerms;
  const outWording = poOut ? new Set([decidedTerm.poText, extractedPoTerms].map(normalizeWording).filter(Boolean)) : null;
  const customerDefault = text(customer?.default_payment_terms);
  const defaultTerms = outWording && outWording.has(normalizeWording(customerDefault)) ? "" : customerDefault;

  return {
    // Written by the ERP sales order attach (attach_sales_order.js).
    voucherNo: order.so_voucher_no || "",
    dated: fmtDate(order.approved_at || order.created_at),
    modeOfPayment: firstText(decidedTerm?.text, poTerms, defaultTerms) || PAYMENT_TERMS_NOT_STATED,
    buyerRef: order.po_number || "",
    regSerialNo: order.registration_serial_no || "",
    // The order's dispatch mode, else blank. It used to default to "By Road".
    dispatchedThrough: text(order.dispatch_mode),
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

// The decided payment term for one order, read only where the terms check is
// on: off stores no check, and a shadow check is hidden from the engineers who
// decide. A mode that cannot be read is an error, not "off", because printing
// the PO's term over a refusal of it is the mistake this read prevents. A
// database without migration 250 has no decisions to read.
const readDecidedPaymentTerm = async (svc, tenantId, orderId) => {
  const m = await readTermsCheckMode(svc, tenantId);
  if (m.error && m.migrated !== false) throw new Error("tenant_settings: " + m.error);
  if (m.mode !== "on") return null;
  const check = await readCurrentCheck(svc, tenantId, orderId);
  if (!check) return null;
  const flags = (await readFlags(svc, tenantId, check.id)).filter((f) => f.clause === "payment_terms");
  if (!flags.length) return null;
  return decidedPaymentTerm(flags, historyByFlag(await readDecisions(svc, tenantId, flags.map((f) => f.id))));
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
      .select("id, status, rule_findings, po_number, po_date, quote_number, quote_id, result, customer_id, created_at, approved_at, dispatch_mode, registration_serial_no, delivery_terms, so_voucher_no, so_message, customer_location_id, delivery_point_contact_id, committed_delivery_date")
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
    const decidedTerm = await readDecidedPaymentTerm(svc, ctx.tenantId, orderId);

    const data = buildSalesOrderData({ order, customer, consigneeLoc, seller, contact, schedules, decidedTerm });
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
