// /api/sales/shipments
//   GET    list (filter by order_id, status)
//   POST   create
//   PATCH  update (status flips, POD attach)
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const STATUSES = new Set(["PLANNED","READY","IN_TRANSIT","AT_PORT","CLEARED","DELIVERED","POD_RECEIVED","EXCEPTION"]);
const MODES = new Set(["SEA","AIR","ROAD","COURIER"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("shipments").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { shipments: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const row = {
        tenant_id: ctx.tenantId,
        order_id: body.order_id || null,
        source_po_id: body.source_po_id || null,
        internal_so_id: body.internal_so_id || null,
        shipment_number: body.shipment_number || null,
        mode: MODES.has(body.mode) ? body.mode : null,
        carrier: body.carrier || null,
        vessel_or_flight: body.vessel_or_flight || null,
        shipper_invoice_no: body.shipper_invoice_no || null,
        ready_date: body.ready_date || null,
        port_of_loading: body.port_of_loading || null,
        port_of_discharge: body.port_of_discharge || null,
        vessel_sailing_date: body.vessel_sailing_date || null,
        port_arrival_date: body.port_arrival_date || null,
        warehouse_receipt_date: body.warehouse_receipt_date || null,
        customer_delivery_date: body.customer_delivery_date || null,
        pod_received: !!body.pod_received,
        pod_document_id: body.pod_document_id || null,
        status: STATUSES.has(body.status) ? body.status : "PLANNED",
        remarks: body.remarks || null,
      };
      const { data, error } = await svc.from("shipments").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "shipment_create", objectType: "shipment", objectId: data.id, after: data });
      if (data.order_id) await recordEvent(ctx, { caseId: data.order_id, eventType: "shipment_created", objectType: "shipment", objectId: data.id });
      return json(res, 201, { shipment: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = { updated_at: new Date().toISOString() };
      const allowed = ["status","carrier","vessel_or_flight","shipper_invoice_no","ready_date","port_of_loading","port_of_discharge","vessel_sailing_date","port_arrival_date","warehouse_receipt_date","customer_delivery_date","pod_received","pod_document_id","asn_sent_at","remarks"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (patch.status && !STATUSES.has(patch.status)) return json(res, 400, { error: { message: "invalid status" } });
      const { data, error } = await svc.from("shipments").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "shipment_update", objectType: "shipment", objectId: body.id, after: patch });
      if (patch.status === "DELIVERED" || patch.status === "POD_RECEIVED") {
        await recordEvent(ctx, { caseId: data.order_id, eventType: patch.status === "DELIVERED" ? "shipment_delivered" : "pod_received", objectType: "shipment", objectId: data.id });
      }
      return json(res, 200, { shipment: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("shipments").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "shipment_delete", objectType: "shipment", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
