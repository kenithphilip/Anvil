// /api/eway_bills
//
// Audit P7.7. e-Way bill (EWB) lifecycle. Persistence is real;
// outbound NIC call happens only when EWB_API_URL is configured.
// Without it, the endpoint stores DRAFT rows so the UI can compose
// EWBs and inspect payloads before regulatory go-live.
//
// GET    list (filter by status, invoice_id, einvoice_id, shipment_id, customer_id)
// POST   create draft (composes payload from invoice or einvoice)
// PATCH  send_to_nic | mark_generated_manually | update_vehicle |
//        extend_validity | cancel | revert_to_draft | plain field edit
// DELETE remove DRAFT (GENERATED rows must use cancel within 24h)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const STATUSES = new Set(["DRAFT", "PENDING_NIC", "GENERATED", "CANCELLED", "REJECTED", "EXPIRED"]);
const VALID_DOC_TYPES = new Set(["INV", "BIL", "BOE", "CHL", "CNT", "RCP", "TRC"]);
const VALID_SUPPLY_TYPES = new Set(["O", "I"]);
const VALID_TRANS_MODES = new Set(["Road", "Rail", "Air", "Ship"]);
const VALID_VEHICLE_TYPES = new Set(["R", "O"]);
const VALID_CANCEL_CODES = new Set([1, 2, 3, 4]);
const EWB_API_URL = process.env.EWB_API_URL || "";
const EWB_API_KEY = process.env.EWB_API_KEY || "";

// EWB threshold below which the bill is not mandatory; the NIC
// schema still accepts low-value entries, but we surface a warning
// in the UI rather than blocking.
const EWB_VALUE_THRESHOLD = 50000;

const transModeCode = (m) => {
  if (m === "Rail") return "2";
  if (m === "Air") return "3";
  if (m === "Ship") return "4";
  return "1";
};

const composePayload = (src, body) => ({
  supplyType: body.supply_type || "O",
  subSupplyType: body.sub_supply_type || "1",
  docType: body.doc_type || "INV",
  docNo: body.doc_no || src.invoice_number || src.doc_no || "",
  docDate: (body.doc_date || src.issue_date || src.invoice_date || "")
    .toString().slice(0, 10).split("-").reverse().join("/"),
  fromGstin: body.from_gstin || src.seller_gstin || "",
  fromTrdName: body.from_trd_name || "",
  fromAddr1: body.from_addr1 || "",
  fromAddr2: body.from_addr2 || "",
  fromPlace: body.from_place || "",
  fromPincode: body.from_pincode ? Number(body.from_pincode) : null,
  fromStateCode: body.from_state_code || "",
  actualFromStateCode: body.from_state_code || "",
  toGstin: body.to_gstin || src.customer_gstin || "",
  toTrdName: body.to_trd_name || "",
  toAddr1: body.to_addr1 || "",
  toAddr2: body.to_addr2 || "",
  toPlace: body.to_place || "",
  toPincode: body.to_pincode ? Number(body.to_pincode) : null,
  toStateCode: body.to_state_code || "",
  actualToStateCode: body.to_state_code || "",
  transactionType: Number(body.transaction_type || 1),
  transMode: transModeCode(body.trans_mode || "Road"),
  transDistance: String(body.trans_distance || ""),
  transporterId: body.transporter_id || "",
  transporterName: body.transporter_name || "",
  transDocNo: body.trans_doc_no || "",
  transDocDate: body.trans_doc_date || "",
  vehicleNo: body.vehicle_no || "",
  vehicleType: body.vehicle_type || "R",
  totalValue: Number(body.taxable_value || 0),
  cgstValue: Number(body.cgst_value || 0),
  sgstValue: Number(body.sgst_value || 0),
  igstValue: Number(body.igst_value || 0),
  cessValue: Number(body.cess_value || 0),
  totInvValue: Number(body.total_inv_value || 0),
  itemList: Array.isArray(body.line_items) ? body.line_items : [],
});

const computeValidity = (distanceKm, generatedAt) => {
  // NIC rule: 1 day per 200 km for regular vehicles, 1 day per 20 km
  // for ODC. We store regular here; the operator overrides for ODC
  // via vehicle_type='O' which the NIC API enforces server-side.
  const days = Math.max(1, Math.ceil((Number(distanceKm) || 0) / 200));
  const start = new Date(generatedAt || Date.now());
  const end = new Date(start.getTime() + days * 86400 * 1000);
  return { from: start.toISOString(), upto: end.toISOString() };
};

const buildPatch = (body) => {
  const patch = { updated_at: new Date().toISOString() };
  const editable = [
    "doc_type", "doc_no", "doc_date", "supply_type", "sub_supply_type", "transaction_type",
    "from_gstin", "from_trd_name", "from_addr1", "from_addr2", "from_place", "from_pincode", "from_state_code",
    "to_gstin", "to_trd_name", "to_addr1", "to_addr2", "to_place", "to_pincode", "to_state_code",
    "trans_mode", "trans_distance", "transporter_id", "transporter_name",
    "trans_doc_no", "trans_doc_date", "vehicle_no", "vehicle_type",
    "taxable_value", "cgst_value", "sgst_value", "igst_value", "cess_value", "total_inv_value",
    "line_items",
  ];
  for (const k of editable) if (body[k] !== undefined) patch[k] = body[k];
  return patch;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("eway_bills").select("*").eq("tenant_id", ctx.tenantId);
      if (id) q = q.eq("id", id);
      if (req.query?.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query?.invoice_id) q = q.eq("invoice_id", req.query.invoice_id);
      if (req.query?.einvoice_id) q = q.eq("einvoice_id", req.query.einvoice_id);
      if (req.query?.shipment_id) q = q.eq("shipment_id", req.query.shipment_id);
      if (req.query?.customer_id) q = q.eq("customer_id", req.query.customer_id);
      q = q.order("created_at", { ascending: false }).limit(500);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      if (id) {
        if (!r.data?.length) return json(res, 404, { error: { message: "eway_bill not found" } });
        return json(res, 200, { eway_bill: r.data[0], nic_configured: !!EWB_API_URL });
      }
      return json(res, 200, { eway_bills: r.data || [], nic_configured: !!EWB_API_URL });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.invoice_id && !body?.einvoice_id && !body?.shipment_id) {
        return json(res, 400, { error: { message: "invoice_id, einvoice_id, or shipment_id required" } });
      }
      if (body.doc_type && !VALID_DOC_TYPES.has(body.doc_type)) return json(res, 400, { error: { message: "invalid doc_type" } });
      if (body.supply_type && !VALID_SUPPLY_TYPES.has(body.supply_type)) return json(res, 400, { error: { message: "invalid supply_type" } });
      if (body.trans_mode && !VALID_TRANS_MODES.has(body.trans_mode)) return json(res, 400, { error: { message: "invalid trans_mode" } });
      if (body.vehicle_type && !VALID_VEHICLE_TYPES.has(body.vehicle_type)) return json(res, 400, { error: { message: "invalid vehicle_type" } });

      // Resolve the source document for default values + tenant
      // ownership check.
      let src = null;
      let customerId = body.customer_id || null;
      if (body.invoice_id) {
        const inv = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
        if (inv.error) throw new Error(inv.error.message);
        if (!inv.data) return json(res, 404, { error: { message: "invoice not found" } });
        src = inv.data;
        if (!customerId) customerId = inv.data.customer_id;
      }
      if (body.einvoice_id) {
        const ei = await svc.from("einvoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.einvoice_id).maybeSingle();
        if (ei.error) throw new Error(ei.error.message);
        if (!ei.data) return json(res, 404, { error: { message: "einvoice not found" } });
        src = src || ei.data;
        if (!customerId) customerId = ei.data.customer_id;
      }
      if (body.shipment_id) {
        const sh = await svc.from("shipments").select("id").eq("tenant_id", ctx.tenantId).eq("id", body.shipment_id).maybeSingle();
        if (sh.error) throw new Error(sh.error.message);
        if (!sh.data) return json(res, 404, { error: { message: "shipment not found" } });
      }

      const docNo = body.doc_no || (src && (src.invoice_number || src.doc_no)) || "";
      const docDate = body.doc_date || (src && (src.issue_date || src.invoice_date)) || new Date().toISOString().slice(0, 10);
      const taxable = Number(body.taxable_value || (src && (src.taxable_value || src.subtotal)) || 0);
      const totalValue = Number(body.total_inv_value || (src && (src.total_value || src.grand_total)) || 0);

      const payload = composePayload(src || {}, { ...body, doc_no: docNo, doc_date: docDate, taxable_value: taxable, total_inv_value: totalValue });
      const ins = await svc.from("eway_bills").insert({
        tenant_id: ctx.tenantId,
        invoice_id: body.invoice_id || null,
        einvoice_id: body.einvoice_id || null,
        shipment_id: body.shipment_id || null,
        customer_id: customerId,
        doc_type: body.doc_type || "INV",
        doc_no: docNo,
        doc_date: docDate,
        supply_type: body.supply_type || "O",
        sub_supply_type: body.sub_supply_type || "1",
        transaction_type: Number(body.transaction_type || 1),
        from_gstin: body.from_gstin || (src && src.seller_gstin) || null,
        from_trd_name: body.from_trd_name || null,
        from_addr1: body.from_addr1 || null,
        from_addr2: body.from_addr2 || null,
        from_place: body.from_place || null,
        from_pincode: body.from_pincode || null,
        from_state_code: body.from_state_code || null,
        to_gstin: body.to_gstin || (src && src.customer_gstin) || null,
        to_trd_name: body.to_trd_name || null,
        to_addr1: body.to_addr1 || null,
        to_addr2: body.to_addr2 || null,
        to_place: body.to_place || null,
        to_pincode: body.to_pincode || null,
        to_state_code: body.to_state_code || null,
        trans_mode: body.trans_mode || "Road",
        trans_distance: body.trans_distance || null,
        transporter_id: body.transporter_id || null,
        transporter_name: body.transporter_name || null,
        trans_doc_no: body.trans_doc_no || null,
        trans_doc_date: body.trans_doc_date || null,
        vehicle_no: body.vehicle_no || null,
        vehicle_type: body.vehicle_type || "R",
        taxable_value: taxable,
        cgst_value: Number(body.cgst_value || 0),
        sgst_value: Number(body.sgst_value || 0),
        igst_value: Number(body.igst_value || 0),
        cess_value: Number(body.cess_value || 0),
        total_inv_value: totalValue,
        line_items: Array.isArray(body.line_items) ? body.line_items : [],
        payload,
        status: "DRAFT",
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "eway_bill_draft",
        objectType: "eway_bill",
        objectId: ins.data.id,
        detail: "doc=" + docNo + " value=" + totalValue + (totalValue < EWB_VALUE_THRESHOLD ? " (below threshold)" : ""),
      });
      return json(res, 201, { eway_bill: ins.data, threshold_warning: totalValue < EWB_VALUE_THRESHOLD });
    }

    if (!id && (req.method === "PATCH" || req.method === "DELETE")) {
      return json(res, 400, { error: { message: "id required" } });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const before = await svc.from("eway_bills").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (before.error) throw new Error(before.error.message);
      if (!before.data) return json(res, 404, { error: { message: "eway_bill not found" } });

      if (body.action === "send_to_nic") {
        if (before.data.status !== "DRAFT") return json(res, 409, { error: { message: "only DRAFT can be sent" } });
        // Vehicle number is mandatory when transMode is Road. We
        // refuse to send incomplete payloads to NIC; the operator
        // gets a clear 400 instead of a cryptic NIC error.
        if ((before.data.trans_mode || "Road") === "Road" && !before.data.vehicle_no) {
          return json(res, 400, { error: { message: "vehicle_no required for Road transport" } });
        }
        const pendingPatch = { status: "PENDING_NIC", updated_at: new Date().toISOString() };
        await svc.from("eway_bills").update(pendingPatch).eq("tenant_id", ctx.tenantId).eq("id", id);
        if (!EWB_API_URL) {
          await recordAudit(ctx, { action: "eway_send_pending", objectType: "eway_bill", objectId: id, detail: "EWB_API_URL not configured" });
          return json(res, 202, { eway_bill: { ...before.data, ...pendingPatch }, note: "EWB_API_URL not configured. Status pending." });
        }
        try {
          const resp = await safeFetch(EWB_API_URL.replace(/\/$/, "") + "/ewayapi", {
            method: "POST",
            headers: { "Content-Type": "application/json", "client_id": EWB_API_KEY },
            body: JSON.stringify(before.data.payload || {}),
          });
          const respJson = await resp.json().catch(() => ({}));
          if (!resp.ok || respJson.status !== "1") {
            const errPatch = { status: "REJECTED", response: respJson, updated_at: new Date().toISOString() };
            await svc.from("eway_bills").update(errPatch).eq("tenant_id", ctx.tenantId).eq("id", id);
            await recordAudit(ctx, { action: "eway_rejected", objectType: "eway_bill", objectId: id, detail: JSON.stringify(respJson).slice(0, 500) });
            return json(res, 422, { eway_bill: { ...before.data, ...errPatch }, error: { message: "NIC rejected", details: respJson } });
          }
          const ok = respJson.data || respJson || {};
          const validity = computeValidity(before.data.trans_distance, ok.ewayBillDate);
          const okPatch = {
            status: "GENERATED",
            ewb_no: ok.ewayBillNo ? String(ok.ewayBillNo) : null,
            ewb_date: ok.ewayBillDate || new Date().toISOString(),
            ewb_valid_from: ok.validFrom || validity.from,
            ewb_valid_upto: ok.validUpto || validity.upto,
            response: respJson,
            updated_at: new Date().toISOString(),
          };
          const out = await svc.from("eway_bills").update(okPatch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
          if (out.error) throw new Error(out.error.message);
          await recordAudit(ctx, { action: "eway_generated", objectType: "eway_bill", objectId: id, detail: "ewb_no=" + (okPatch.ewb_no || "?") });
          return json(res, 200, { eway_bill: out.data });
        } catch (err) {
          await svc.from("eway_bills").update({ status: "REJECTED", response: { error: err.message }, updated_at: new Date().toISOString() }).eq("tenant_id", ctx.tenantId).eq("id", id);
          return json(res, 502, { error: { message: "NIC call failed: " + err.message } });
        }
      }

      if (body.action === "mark_generated_manually") {
        if (before.data.status !== "PENDING_NIC") {
          return json(res, 409, { error: { message: "only PENDING_NIC can be marked GENERATED manually" } });
        }
        if (!body.ewb_no) return json(res, 400, { error: { message: "ewb_no required" } });
        const validity = computeValidity(before.data.trans_distance, body.ewb_date);
        const patch = {
          status: "GENERATED",
          ewb_no: String(body.ewb_no),
          ewb_date: body.ewb_date || new Date().toISOString(),
          ewb_valid_from: body.ewb_valid_from || validity.from,
          ewb_valid_upto: body.ewb_valid_upto || validity.upto,
          response: { manual: true, by: ctx.user?.id || null },
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "eway_mark_generated_manually", objectType: "eway_bill", objectId: id, after: { ewb_no: patch.ewb_no } });
        return json(res, 200, { eway_bill: out.data });
      }

      if (body.action === "update_vehicle") {
        if (before.data.status !== "GENERATED") {
          return json(res, 409, { error: { message: "vehicle update only allowed on GENERATED" } });
        }
        if (!body.vehicle_no) return json(res, 400, { error: { message: "vehicle_no required" } });
        const patch = {
          vehicle_no: body.vehicle_no,
          vehicle_type: body.vehicle_type || before.data.vehicle_type,
          trans_doc_no: body.trans_doc_no || before.data.trans_doc_no,
          trans_doc_date: body.trans_doc_date || before.data.trans_doc_date,
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "eway_vehicle_update", objectType: "eway_bill", objectId: id, after: patch });
        return json(res, 200, { eway_bill: out.data });
      }

      if (body.action === "extend_validity") {
        if (before.data.status !== "GENERATED") {
          return json(res, 409, { error: { message: "extend allowed only on GENERATED" } });
        }
        // NIC permits extension within 8h before / after expiry. We
        // surface the rule but defer the API call to the operator's
        // explicit reason; this PATCH stores the request only.
        if (!body.extension_reason_code || !body.remaining_distance) {
          return json(res, 400, { error: { message: "extension_reason_code and remaining_distance required" } });
        }
        const validity = computeValidity(body.remaining_distance, new Date().toISOString());
        const patch = {
          ewb_valid_upto: validity.upto,
          response: { ...(before.data.response || {}), last_extension: { reason: body.extension_reason_code, at: new Date().toISOString() } },
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "eway_extend", objectType: "eway_bill", objectId: id, detail: "reason=" + body.extension_reason_code });
        return json(res, 200, { eway_bill: out.data });
      }

      if (body.action === "cancel") {
        if (before.data.status !== "GENERATED") {
          return json(res, 409, { error: { message: "only GENERATED can be cancelled" } });
        }
        if (!body.cancel_reason_code || !VALID_CANCEL_CODES.has(Number(body.cancel_reason_code))) {
          return json(res, 400, { error: { message: "cancel_reason_code required (1-4)" } });
        }
        const ageHours = (Date.now() - new Date(before.data.ewb_date || before.data.created_at).getTime()) / 3600000;
        if (ageHours > 24) return json(res, 422, { error: { message: "NIC allows cancellation only within 24 hours of generation" } });
        const patch = {
          status: "CANCELLED",
          cancel_reason_code: Number(body.cancel_reason_code),
          cancel_remarks: body.cancel_remarks || null,
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "eway_cancel", objectType: "eway_bill", objectId: id, after: { reason: patch.cancel_reason_code } });
        return json(res, 200, { eway_bill: out.data });
      }

      if (body.action === "revert_to_draft") {
        if (!["PENDING_NIC", "REJECTED"].includes(before.data.status)) {
          return json(res, 409, { error: { message: "only PENDING_NIC or REJECTED can revert to DRAFT" } });
        }
        const patch = { status: "DRAFT", response: {}, updated_at: new Date().toISOString() };
        const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "eway_revert_to_draft", objectType: "eway_bill", objectId: id, before: { status: before.data.status }, after: { status: "DRAFT" } });
        return json(res, 200, { eway_bill: out.data });
      }

      // Plain field edit: DRAFT only.
      if (before.data.status !== "DRAFT") return json(res, 409, { error: { message: "only DRAFT can be edited" } });
      const patch = buildPatch(body);
      if (patch.doc_type && !VALID_DOC_TYPES.has(patch.doc_type)) return json(res, 400, { error: { message: "invalid doc_type" } });
      if (patch.supply_type && !VALID_SUPPLY_TYPES.has(patch.supply_type)) return json(res, 400, { error: { message: "invalid supply_type" } });
      if (patch.trans_mode && !VALID_TRANS_MODES.has(patch.trans_mode)) return json(res, 400, { error: { message: "invalid trans_mode" } });
      if (patch.vehicle_type && !VALID_VEHICLE_TYPES.has(patch.vehicle_type)) return json(res, 400, { error: { message: "invalid vehicle_type" } });
      // Re-compose payload so the cached request body matches the
      // edited fields.
      patch.payload = composePayload({}, { ...before.data, ...patch });
      const out = await svc.from("eway_bills").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: "eway_update", objectType: "eway_bill", objectId: id });
      return json(res, 200, { eway_bill: out.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const before = await svc.from("eway_bills").select("status").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!before.data) return json(res, 404, { error: { message: "eway_bill not found" } });
      if (before.data.status === "GENERATED") {
        return json(res, 409, { error: { message: "cannot delete GENERATED. Cancel within 24h instead." } });
      }
      const { error } = await svc.from("eway_bills").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "eway_delete", objectType: "eway_bill", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
