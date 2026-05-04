// POST /api/orders/traveler  Body: { orderId, printer_id?, queue?: true }
//
// Generates a traveler PDF for a sales order. Reuses the existing
// PDF renderer. When `queue=true` (or tenant has travelers_auto_print
// enabled) we also enqueue a print_jobs row for the on-prem CUPS/IPP
// relay to pick up.
//
// Wired into the ERP push handlers: each connector's push.js can
// import enqueueTravelerForOrder to fire this at successful export.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderQuotePdf } from "../_lib/pdf-renderer.js";
import { tenantSettings } from "../_lib/stripe-client.js";

const enqueueTraveler = async (svc, { tenantId, orderId, pdfStoragePath, pdfSignedUrl, printerId, triggeredBy }) => {
  const ins = await svc.from("print_jobs").insert({
    tenant_id: tenantId,
    order_id: orderId,
    printer_id: printerId || null,
    pdf_storage_path: pdfStoragePath || null,
    pdf_signed_url: pdfSignedUrl || null,
    status: "queued",
    triggered_by: triggeredBy || "manual",
  }).select("id").single();
  return ins.data?.id || null;
};

// Exported so ERP push handlers can call this directly when an
// export completes successfully (Smartbase-parity auto-print).
export const enqueueTravelerForOrder = async (svc, { tenantId, orderId, triggeredBy = "erp_push" }) => {
  const settings = await tenantSettings(svc, tenantId);
  if (!settings?.travelers_auto_print) return null;
  const orderQ = await svc.from("orders").select("*").eq("tenant_id", tenantId).eq("id", orderId).maybeSingle();
  if (!orderQ.data) return null;
  let customer = null;
  if (orderQ.data.customer_id) {
    const c = await svc.from("customers").select("*").eq("id", orderQ.data.customer_id).maybeSingle();
    customer = c.data || null;
  }
  // Render + upload.
  const pdfBuffer = await renderQuotePdf({
    tenant: { display_name: "Anvil" },
    customer: customer || {},
    salesOrder: orderQ.data.result?.salesOrder || {},
    brand: { title: "Production Traveler" },
  }).catch(() => null);
  if (!pdfBuffer) return null;
  const prefix = (settings.travelers_storage_prefix || "travelers/").replace(/\/?$/, "/");
  const path = prefix + tenantId + "/" + orderId + ".pdf";
  let signedUrl = null;
  try {
    await svc.storage.from("anvil-documents").upload(path, pdfBuffer, {
      contentType: "application/pdf", upsert: true,
    });
    const sign = await svc.storage.from("anvil-documents").createSignedUrl(path, 7 * 24 * 3600);
    if (sign.data?.signedUrl) signedUrl = sign.data.signedUrl;
  } catch (_e) { /* swallow; the row still gets enqueued without a URL */ }
  const id = await enqueueTraveler(svc, {
    tenantId, orderId,
    pdfStoragePath: path,
    pdfSignedUrl: signedUrl,
    printerId: settings.travelers_default_printer || null,
    triggeredBy,
  });
  return id;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.orderId) return json(res, 400, { error: { message: "orderId required" } });
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).maybeSingle();
    if (orderQ.error) throw new Error(orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "order not found" } });
    let customer = null;
    if (orderQ.data.customer_id) {
      const c = await svc.from("customers").select("*").eq("id", orderQ.data.customer_id).maybeSingle();
      customer = c.data || null;
    }
    const pdfBuffer = await renderQuotePdf({
      tenant: { display_name: "Anvil" },
      customer: customer || {},
      salesOrder: orderQ.data.result?.salesOrder || {},
      brand: { title: "Production Traveler" },
    });
    const prefix = (settings?.travelers_storage_prefix || "travelers/").replace(/\/?$/, "/");
    const path = prefix + ctx.tenantId + "/" + orderQ.data.id + ".pdf";
    let signedUrl = null;
    try {
      await svc.storage.from("anvil-documents").upload(path, pdfBuffer, {
        contentType: "application/pdf", upsert: true,
      });
      const sign = await svc.storage.from("anvil-documents").createSignedUrl(path, 7 * 24 * 3600);
      if (sign.data?.signedUrl) signedUrl = sign.data.signedUrl;
    } catch (_e) { /* uploads can be best-effort */ }

    let printJobId = null;
    if (body.queue || settings?.travelers_auto_print) {
      printJobId = await enqueueTraveler(svc, {
        tenantId: ctx.tenantId, orderId: orderQ.data.id,
        pdfStoragePath: path, pdfSignedUrl: signedUrl,
        printerId: body.printer_id || settings?.travelers_default_printer || null,
        triggeredBy: "manual",
      });
    }
    await recordAudit(ctx, {
      action: "traveler_generated", objectType: "order", objectId: orderQ.data.id,
      detail: printJobId ? ("queued::" + printJobId) : "no_queue",
    });
    return json(res, 200, {
      ok: true,
      pdf_signed_url: signedUrl,
      pdf_storage_path: path,
      print_job_id: printJobId,
    });
  } catch (err) { sendError(res, err); }
}
