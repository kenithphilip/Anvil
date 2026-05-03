// POST /api/inventory/availability
// Body: { lineItems: [{ partNo, qty }] }
// Returns: lines: [{ partNo, requestedQty, availableQty, reservedQty, atp, status, source }]

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const cleanName = (s) => String(s || "").trim().toLowerCase();

const classify = (avail, reserved, requested, reorder) => {
  const atp = avail - reserved;
  if (atp >= requested) {
    if (reorder > 0 && (atp - requested) < reorder) return "below_reorder";
    return "in_stock";
  }
  if (atp > 0) return "partial";
  if (atp === 0 && requested > 0) return "source_po_required";
  return "no_data";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const items = Array.isArray(body.lineItems) ? body.lineItems : [];
    if (!items.length) return json(res, 200, { lines: [] });
    const svc = serviceClient();
    const partNames = items.map((li) => cleanName(li.partNo)).filter(Boolean);
    const inv = await svc.from("tally_inventory").select("stock_item_name, available_qty, reserved_qty, reorder_level, uom").eq("tenant_id", ctx.tenantId);
    const map = new Map();
    (inv.data || []).forEach((row) => {
      map.set(cleanName(row.stock_item_name), row);
    });
    // Pull open source POs and open SOs to compute true ATP.
    const openSourcePos = await svc.from("source_pos").select("payload, status").eq("tenant_id", ctx.tenantId).in("status", ["DRAFT","PENDING_INTERNAL_APPROVAL","SENT_TO_SUPPLIER","SUPPLIER_ACK","ETA_CONFIRMED","DELAYED"]);
    const inboundByPart = new Map();
    (openSourcePos.data || []).forEach((row) => {
      const lines = (row.payload && row.payload.lineItems) || [];
      lines.forEach((li) => {
        const key = cleanName(li.partNumber || li.partNo || li.tallyItemName || li.itemName);
        if (!key) return;
        inboundByPart.set(key, (inboundByPart.get(key) || 0) + (Number(li.qty) || 0));
      });
    });
    const openSos = await svc.from("orders").select("result, status").eq("tenant_id", ctx.tenantId).in("status", ["APPROVED","PENDING_REVIEW","EXPORTED_TO_TALLY"]);
    const reservedByPart = new Map();
    (openSos.data || []).forEach((row) => {
      const lines = (row.result && row.result.salesOrder && row.result.salesOrder.lineItems) || [];
      lines.forEach((li) => {
        const key = cleanName(li.tallyItemName || li.itemName || li.sellerPartNo);
        if (!key) return;
        reservedByPart.set(key, (reservedByPart.get(key) || 0) + (Number(li.qty) || 0));
      });
    });

    const lines = items.map((li) => {
      const key = cleanName(li.partNo);
      const row = map.get(key) || null;
      const requestedQty = Number(li.qty) || 0;
      const availableQty = row ? Number(row.available_qty) : 0;
      const reservedQty = row ? Number(row.reserved_qty) : 0;
      const openSoReserved = reservedByPart.get(key) || 0;
      const inbound = inboundByPart.get(key) || 0;
      const reorder = row ? Number(row.reorder_level) : 0;
      const atp = availableQty - reservedQty - openSoReserved + inbound;
      const status = row ? classify(availableQty, reservedQty + openSoReserved, requestedQty, reorder) : (inbound > 0 ? "source_po_required" : "no_data");
      return { partNo: li.partNo, requestedQty, availableQty, reservedQty, openSoReserved, inboundFromSourcePos: inbound, atp, status, source: row ? "tally_inventory" : (inbound > 0 ? "source_po" : "missing"), uom: row ? row.uom : null };
    });
    return json(res, 200, { lines });
  } catch (err) {
    sendError(res, err);
  }
}
