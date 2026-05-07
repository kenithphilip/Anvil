// /api/einvoice
// e-Invoice (GSTN IRN/QR) lifecycle. Persistence is real; outbound GSTN call
// happens only when GSTN_API_URL is configured. Without it, the endpoint
// stores DRAFT rows so the UI can still compose invoices and inspect payloads.
//
// GET    list (filter by status, order_id, customer_id)
// POST   create draft from order (composes the JSON payload from order fields)
// PATCH  send to GSTN, mark generated/rejected, cancel within 24h window
// DELETE remove a draft (cannot delete a GENERATED row, only cancel)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const STATUSES = new Set(["DRAFT", "PENDING_GSTN", "GENERATED", "CANCELLED", "REJECTED"]);
const GSTN_API_URL = process.env.GSTN_API_URL || "";
const GSTN_API_KEY = process.env.GSTN_API_KEY || "";

const composePayload = (order, customer, sellerGstin) => {
  const so = (order.result && order.result.salesOrder) || {};
  const lineItems = so.lineItems || [];
  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: "B2B",
      RegRev: "N",
      EcmGstin: null,
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: "INV",
      No: order.po_number || ("ORD-" + String(order.id).slice(0, 8)),
      Dt: (order.created_at || new Date().toISOString()).slice(0, 10).split("-").reverse().join("/"),
    },
    SellerDtls: {
      Gstin: sellerGstin || "",
      LglNm: "Obara India Pvt. Ltd.",
      Addr1: "W-17 F2 Block MIDC PIMPRI",
      Loc: "Pune",
      Pin: 411018,
      Stcd: "27",
    },
    BuyerDtls: {
      Gstin: customer ? (customer.gstin || "") : "",
      LglNm: customer ? (customer.customer_name || customer.customer_key) : "",
      Pos: customer ? (customer.state_code || "") : "",
      Addr1: customer && customer.address_line1 ? customer.address_line1 : "",
      Loc: customer ? (customer.city || "") : "",
      Pin: customer && customer.pincode ? Number(customer.pincode) : null,
      Stcd: customer ? (customer.state_code || "") : "",
    },
    ItemList: lineItems.map((li, i) => ({
      SlNo: String(i + 1),
      PrdDesc: li.itemName || li.tallyItemName || li.partNumber || "",
      IsServc: "N",
      HsnCd: li.hsnCode || "",
      Qty: Number(li.qty) || 0,
      Unit: li.uom || "NOS",
      UnitPrice: Number(li.rate) || 0,
      TotAmt: Number(li.amount) || 0,
      AssAmt: Number(li.amount) || 0,
      GstRt: Number(li.cgst || 0) + Number(li.sgst || 0) || Number(li.igst || 0),
      IgstAmt: Number(li.igstAmt || 0),
      CgstAmt: Number(li.cgstAmt || 0),
      SgstAmt: Number(li.sgstAmt || 0),
      TotItemVal: Number(li.totalWithGst || li.amount || 0),
    })),
    ValDtls: {
      AssVal: Number(so.subTotal) || 0,
      IgstVal: Number(so.igstTotal) || 0,
      CgstVal: Number(so.cgstTotal) || 0,
      SgstVal: Number(so.sgstTotal) || 0,
      TotInvVal: Number(so.grandTotal) || 0,
    },
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("einvoices").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { einvoices: data || [], gstn_configured: !!GSTN_API_URL });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.order_id || !body.invoice_number || !body.invoice_date) {
        return json(res, 400, { error: { message: "order_id, invoice_number, invoice_date required" } });
      }
      const order = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.order_id).single();
      if (order.error || !order.data) return json(res, 404, { error: { message: "Order not found" } });
      let customer = null;
      if (order.data.customer_id) {
        const c = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", order.data.customer_id).single();
        if (c.data) customer = c.data;
        // Audit fix (May 2026): einvoice handler used to read
        // address_line1 / city / pincode directly from `customers`,
        // but those columns live on `customer_locations`. Pull the
        // default location (or the order's customer_location_id if
        // set) and merge it onto the customer object so the existing
        // BuyerDtls section keeps working.
        if (customer) {
          let location = null;
          if (order.data.customer_location_id) {
            const locQ = await svc.from("customer_locations").select("*")
              .eq("tenant_id", ctx.tenantId)
              .eq("id", order.data.customer_location_id)
              .maybeSingle();
            location = locQ.data || null;
          }
          if (!location) {
            const defQ = await svc.from("customer_locations").select("*")
              .eq("tenant_id", ctx.tenantId)
              .eq("customer_id", customer.id)
              .eq("is_default", true)
              .maybeSingle();
            location = defQ.data || null;
          }
          if (!location) {
            // Fallback: any location for this customer (oldest first
            // to keep the choice deterministic).
            const anyQ = await svc.from("customer_locations").select("*")
              .eq("tenant_id", ctx.tenantId)
              .eq("customer_id", customer.id)
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            location = anyQ.data || null;
          }
          if (location) {
            customer = {
              ...customer,
              address_line1: customer.address_line1 || location.address_line1 || null,
              address_line2: customer.address_line2 || location.address_line2 || null,
              city: customer.city || location.city || null,
              pincode: customer.pincode || location.pincode || null,
              // Prefer the location's GSTIN/state when present (a
              // multi-plant customer's e-invoice should use the
              // shipping location's tax registration).
              gstin: location.gstin || customer.gstin || null,
              state_code: location.state_code || customer.state_code || null,
            };
          }
        }
      }
      const so = (order.data.result && order.data.result.salesOrder) || {};
      const payload = composePayload(order.data, customer, body.seller_gstin || null);
      const row = {
        tenant_id: ctx.tenantId,
        order_id: body.order_id,
        shipment_id: body.shipment_id || null,
        invoice_number: body.invoice_number,
        invoice_date: body.invoice_date,
        customer_id: order.data.customer_id || null,
        customer_gstin: customer ? customer.gstin : null,
        seller_gstin: body.seller_gstin || null,
        taxable_value: Number(so.subTotal) || null,
        total_value: Number(so.grandTotal) || null,
        currency: body.currency || "INR",
        status: "DRAFT",
        payload,
      };
      const { data, error } = await svc.from("einvoices").upsert(row, { onConflict: "tenant_id,invoice_number" }).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "einvoice_draft", objectType: "einvoice", objectId: data.id, after: data });
      return json(res, 201, { einvoice: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const before = await svc.from("einvoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
      if (before.error || !before.data) return json(res, 404, { error: { message: "einvoice not found" } });
      if (body.action === "send_to_gstn") {
        if (before.data.status !== "DRAFT") return json(res, 409, { error: { message: "only DRAFT can be sent" } });
        const patch = { status: "PENDING_GSTN", updated_at: new Date().toISOString() };
        await svc.from("einvoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id);
        if (!GSTN_API_URL) {
          // No real provider configured. Stay PENDING_GSTN so the UI can show
          // the next required step (set GSTN_API_URL or manually mark generated).
          await recordAudit(ctx, { action: "einvoice_send_pending", objectType: "einvoice", objectId: body.id, detail: "GSTN_API_URL not configured" });
          return json(res, 202, { einvoice: { ...before.data, ...patch }, note: "GSTN_API_URL not configured. Status pending." });
        }
        try {
          const resp = await safeFetch(GSTN_API_URL.replace(/\/$/, "") + "/eivital/v1.04/Invoice", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "client_id": GSTN_API_KEY,
            },
            body: JSON.stringify(before.data.payload || {}),
          });
          const respJson = await resp.json().catch(() => ({}));
          if (!resp.ok || respJson.Status !== "1") {
            const errPatch = { status: "REJECTED", response: respJson, updated_at: new Date().toISOString() };
            await svc.from("einvoices").update(errPatch).eq("tenant_id", ctx.tenantId).eq("id", body.id);
            await recordAudit(ctx, { action: "einvoice_rejected", objectType: "einvoice", objectId: body.id, detail: JSON.stringify(respJson).slice(0, 500) });
            return json(res, 422, { einvoice: { ...before.data, ...errPatch }, error: { message: "GSTN rejected", details: respJson } });
          }
          const ok = respJson.Data || {};
          const okPatch = {
            status: "GENERATED",
            irn: ok.Irn || null,
            ack_no: ok.AckNo ? String(ok.AckNo) : null,
            ack_date: ok.AckDt || null,
            qr_code_b64: ok.SignedQRCode || null,
            signed_invoice_b64: ok.SignedInvoice || null,
            ewb_no: ok.EwbNo ? String(ok.EwbNo) : null,
            ewb_valid_upto: ok.EwbValidTill || null,
            response: respJson,
            updated_at: new Date().toISOString(),
          };
          const out = await svc.from("einvoices").update(okPatch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
          if (out.error) throw new Error(out.error.message);
          await recordAudit(ctx, { action: "einvoice_generated", objectType: "einvoice", objectId: body.id, detail: "irn=" + (ok.Irn || "?") });
          return json(res, 200, { einvoice: out.data });
        } catch (err) {
          await svc.from("einvoices").update({ status: "REJECTED", response: { error: err.message } }).eq("tenant_id", ctx.tenantId).eq("id", body.id);
          return json(res, 502, { error: { message: "GSTN call failed: " + err.message } });
        }
      }
      if (body.action === "cancel") {
        if (before.data.status !== "GENERATED") return json(res, 409, { error: { message: "only GENERATED can be cancelled" } });
        const ageHours = (Date.now() - new Date(before.data.ack_date || before.data.created_at).getTime()) / 3600000;
        if (ageHours > 24) return json(res, 422, { error: { message: "GSTN allows cancellation only within 24 hours" } });
        const patch = {
          status: "CANCELLED",
          cancel_reason: body.cancel_reason || null,
          cancel_remarks: body.cancel_remarks || null,
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("einvoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "einvoice_cancel", objectType: "einvoice", objectId: body.id, after: patch });
        return json(res, 200, { einvoice: out.data });
      }
      // Plain field update on DRAFT only.
      if (before.data.status !== "DRAFT") return json(res, 409, { error: { message: "only DRAFT can be edited" } });
      const editable = ["invoice_date", "seller_gstin", "shipment_id", "currency", "payload"];
      const patch = { updated_at: new Date().toISOString() };
      for (const k of editable) if (body[k] !== undefined) patch[k] = body[k];
      const out = await svc.from("einvoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: "einvoice_update", objectType: "einvoice", objectId: body.id, after: patch });
      return json(res, 200, { einvoice: out.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const before = await svc.from("einvoices").select("status").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (before.data && before.data.status === "GENERATED") {
        return json(res, 409, { error: { message: "cannot delete GENERATED. cancel within 24h instead." } });
      }
      const { error } = await svc.from("einvoices").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "einvoice_delete", objectType: "einvoice", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
