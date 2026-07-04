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

// Build the SellerDtls block from per-tenant einvoice_seller_*
// columns on tenant_settings (migration 062). Audit P1.2 (May
// 2026): this block was previously hardcoded to a single tenant for
// every tenant; the GSTN API rejected the payload because the
// supplied GSTIN never matched the registered legal name + address.
// Now, when the tenant has not configured the seller block, the
// caller fails fast with a structured 409 instead of shipping a
// payload that GSTN will reject.
const buildSellerDtls = (tenantSettings, override) => {
  const ts = tenantSettings || {};
  const gstin = override?.gstin || ts.einvoice_seller_gstin || null;
  const legalName = ts.einvoice_seller_legal_name || null;
  const stateCode = ts.einvoice_seller_state_code || null;
  if (!gstin || !legalName || !stateCode) return { error: "einvoice_seller_not_configured" };
  const pinRaw = ts.einvoice_seller_pincode;
  const pin = pinRaw == null ? null : Number(String(pinRaw).replace(/\D/g, "")) || null;
  const block = {
    Gstin: gstin,
    LglNm: legalName,
    Addr1: ts.einvoice_seller_address_line1 || "",
    Loc: ts.einvoice_seller_locality || "",
    Pin: pin,
    Stcd: stateCode,
  };
  if (ts.einvoice_seller_trade_name) block.TrdNm = ts.einvoice_seller_trade_name;
  if (ts.einvoice_seller_address_line2) block.Addr2 = ts.einvoice_seller_address_line2;
  if (ts.einvoice_seller_phone) block.Ph = ts.einvoice_seller_phone;
  if (ts.einvoice_seller_email) block.Em = ts.einvoice_seller_email;
  return { block };
};

const composePayload = (order, customer, sellerDtls) => {
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
    SellerDtls: sellerDtls,
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
      // Audit P1.2 (May 2026): pull seller details from per-tenant
      // einvoice_seller_* columns on tenant_settings (migration 062).
      // If the tenant has not configured them, refuse to compose
      // a payload rather than ship one tenant's address with someone
      // else's GSTIN.
      const tsQ = await svc.from("tenant_settings")
        .select("einvoice_seller_gstin, einvoice_seller_legal_name, einvoice_seller_trade_name, einvoice_seller_address_line1, einvoice_seller_address_line2, einvoice_seller_locality, einvoice_seller_pincode, einvoice_seller_state_code, einvoice_seller_phone, einvoice_seller_email")
        .eq("tenant_id", ctx.tenantId).maybeSingle();
      const tenantSettingsRow = tsQ.data || {};
      const sellerResult = buildSellerDtls(tenantSettingsRow, { gstin: body.seller_gstin });
      if (sellerResult.error) {
        return json(res, 409, {
          error: {
            code: "EINVOICE_SELLER_NOT_CONFIGURED",
            message: "e-Invoice seller details (GSTIN, legal name, state code) are not configured for this tenant. Set them under Admin > e-Invoice before composing a payload.",
          },
        });
      }
      const payload = composePayload(order.data, customer, sellerResult.block);
      const row = {
        tenant_id: ctx.tenantId,
        order_id: body.order_id,
        shipment_id: body.shipment_id || null,
        invoice_number: body.invoice_number,
        invoice_date: body.invoice_date,
        customer_id: order.data.customer_id || null,
        customer_gstin: customer ? customer.gstin : null,
        seller_gstin: sellerResult.block.Gstin,
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
      if (body.action === "revert_to_draft") {
        // Stuck-state escape hatch. When GSTN_API_URL isn't configured
        // OR a transient send call hung, e-invoices stayed forever in
        // PENDING_GSTN with no UI button to recover. This action flips
        // PENDING_GSTN (and REJECTED) back to DRAFT so the operator
        // can edit and retry. GENERATED rows must use cancel_action
        // (24h window) instead.
        if (!["PENDING_GSTN", "REJECTED"].includes(before.data.status)) {
          return json(res, 409, { error: { message: "only PENDING_GSTN or REJECTED can revert to DRAFT" } });
        }
        const patch = {
          status: "DRAFT",
          response: null,
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("einvoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "einvoice_revert_to_draft", objectType: "einvoice", objectId: body.id, before: { status: before.data.status }, after: patch });
        return json(res, 200, { einvoice: out.data });
      }
      if (body.action === "mark_generated_manually") {
        // Manual escape hatch when the IRN was generated out-of-band
        // (operator generated it via the GSTN portal directly because
        // the API integration is down). The operator pastes the IRN
        // and ack date so the row reflects reality.
        if (before.data.status !== "PENDING_GSTN") {
          return json(res, 409, { error: { message: "only PENDING_GSTN can be marked GENERATED manually" } });
        }
        if (!body.irn) return json(res, 400, { error: { message: "irn required" } });
        const patch = {
          status: "GENERATED",
          irn: body.irn,
          ack_no: body.ack_no || null,
          ack_date: body.ack_date || new Date().toISOString(),
          response: { manual: true, by: ctx.user?.id || null },
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("einvoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "einvoice_mark_generated_manually", objectType: "einvoice", objectId: body.id, after: patch });
        return json(res, 200, { einvoice: out.data });
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
