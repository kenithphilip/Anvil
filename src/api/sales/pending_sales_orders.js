// /api/sales/pending_sales_orders
//   GET ?customer_id=<uuid>  [&owner_id= | &mine=1]
//
// The per-customer "Pending Sales Order" tracker: one row per OPEN sales-order
// line (balance > 0), stitching the whole supply chain onto each line so sales
// can quote a ready/delivery date and see where the holdup is. Mirrors the
// logistics team's Gestamp workbook.
//
// Per line it resolves:
//   • description + part_no  — split from the Tally-munged Description via
//     pending-so/part-origin (the dedicated Part No cell is usually empty).
//   • Ordered / Supplied / Balance — reusing the dispatch-register rollup.
//   • Initial delivery date (A) — order_schedule_lines.scheduled_date by
//     line_index, else the order-level committed_delivery_date.
//   • Source Po No + origin — matched source_pos.reference (by part_no), then
//     classified local(-I, work order) vs import(O/x, procurement PO).
//   • Ready date — shipments.ready_date (import) else source_po acknowledged_eta.
//   • In-transit ladder — via shipment_lines -> the carrying shipment (import
//     branch only; local -I work-order lines have no ladder).
//   • Aging — Days-from-PO off orders.po_date, with a 90-day flag.
//
// Read-only + level-gated; no named RBAC action.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { extractPoLines, buildDispatchRegister } from "../_lib/dispatch-register.js";
import { splitTallyPartDescription, classifyOrigin } from "../_lib/pending-so/part-origin.js";

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

// Orders still being fulfilled. Terminal / non-real statuses are excluded; the
// real per-line gate is balance > 0 below.
const OPEN_STATUSES = new Set(["PENDING_REVIEW", "APPROVED", "BLOCKED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT"]);

const RATE_KEYS = ["discounted_unit_price", "unit_price", "rate", "unitPrice"];
const DRAWING_KEYS = ["drawing_no", "drawingNo", "drawing"];
const rawField = (line, keys) => { for (const k of keys) { if (line && line[k] != null && line[k] !== "") return line[k]; } return null; };

const DAY_MS = 86400000;
const daysSince = (d) => {
  if (!d) return null;
  const t = new Date(String(d).slice(0, 10)).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const tenantId = ctx.tenantId;
    const customerId = req.query.customer_id;
    if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });

    // 1. Customer + its open orders.
    const { data: customer } = await svc.from("customers")
      .select("id, customer_name, display_name").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
    const { data: allOrders, error: oErr } = await svc.from("orders")
      .select("id, po_number, po_date, status, order_mode, committed_delivery_date, opportunity_id, result, created_at")
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .order("po_date", { ascending: true }).limit(500);
    if (oErr) throw new Error(oErr.message);
    const orders = (allOrders || []).filter((o) => OPEN_STATUSES.has(o.status));
    const orderIds = orders.map((o) => o.id);
    if (!orderIds.length) return json(res, 200, { customer: customer || null, rows: [] });

    // 2. Batch the supply-chain joins.
    const inOrders = (q) => q.eq("tenant_id", tenantId).in("order_id", orderIds);
    const [dispatchRes, scheduleRes, spoRes] = await Promise.all([
      inOrders(svc.from("dispatch_lines").select("order_id, shipment_id, line_index, part_no, dispatched_qty, dispatch_date, invoice_number")),
      inOrders(svc.from("order_schedule_lines").select("order_id, line_index, part_no, scheduled_date")),
      inOrders(svc.from("source_pos").select("id, order_id, reference, supplier, country, acknowledged_eta")),
    ]);
    const dispatchByOrder = groupBy(dispatchRes.data || [], "order_id");
    const scheduleByOrder = groupBy(scheduleRes.data || [], "order_id");
    const spos = spoRes.data || [];
    const spoByOrder = groupBy(spos, "order_id");
    const spoById = new Map(spos.map((s) => [s.id, s]));

    // source_po_lines for those POs, then the shipment_lines that carried them,
    // then the carrying shipment headers.
    const spoIds = spos.map((s) => s.id);
    const [spoLineRes, shipLineRes] = await Promise.all([
      spoIds.length ? svc.from("source_po_lines").select("id, source_po_id, part_no, acknowledged_eta, received_qty, received_at").eq("tenant_id", tenantId).in("source_po_id", spoIds) : { data: [] },
      spoIds.length ? svc.from("shipment_lines").select("shipment_id, source_po_id, source_po_line_id, part_no, received_qty, receipt_date").eq("tenant_id", tenantId).in("source_po_id", spoIds) : { data: [] },
    ]);
    const spoLines = spoLineRes.data || [];
    const shipLines = shipLineRes.data || [];
    const shipmentIds = uniq(shipLines.map((sl) => sl.shipment_id));
    const { data: shipments } = shipmentIds.length
      ? await svc.from("shipments").select("id, shipper_invoice_no, mode, carrier, vessel_or_flight, port_of_discharge, ready_date, vessel_sailing_date, port_arrival_date, warehouse_receipt_date, status").eq("tenant_id", tenantId).in("id", shipmentIds)
      : { data: [] };
    const shipmentById = new Map((shipments || []).map((s) => [s.id, s]));

    // Index: per source_po, part_no -> source_po_line; and the shipment_line +
    // shipment reachable from that part.
    const spoLineKey = (spoId, part) => `${spoId}::${norm(part)}`;
    const spoLineByKey = new Map();
    for (const l of spoLines) spoLineByKey.set(spoLineKey(l.source_po_id, l.part_no), l);
    const shipLineBySpoLine = new Map();
    const shipLineByKey = new Map();
    for (const sl of shipLines) {
      if (sl.source_po_line_id) shipLineBySpoLine.set(sl.source_po_line_id, sl);
      shipLineByKey.set(spoLineKey(sl.source_po_id, sl.part_no), sl);
    }

    // Resolve a part within an order to its { source_po, spoLine, shipLine, shipment }.
    const resolveSupply = (orderId, part) => {
      const p = norm(part);
      if (!p) return {};
      for (const spo of (spoByOrder.get(orderId) || [])) {
        const spoLine = spoLineByKey.get(spoLineKey(spo.id, part));
        const shipLine = (spoLine && shipLineBySpoLine.get(spoLine.id)) || shipLineByKey.get(spoLineKey(spo.id, part));
        if (spoLine || shipLine) {
          const shipment = shipLine ? shipmentById.get(shipLine.shipment_id) : null;
          return { source_po: spo, spoLine: spoLine || null, shipLine: shipLine || null, shipment: shipment || null };
        }
      }
      // No source_po_line matched, but the order may still have exactly one PO
      // (common for single-supplier lines) — surface its reference as a hint.
      const only = spoByOrder.get(orderId);
      if (only && only.length === 1) return { source_po: only[0] };
      return {};
    };

    // 3. Per order, roll up Ordered/Supplied/Balance, then emit one row per open line.
    const rows = [];
    for (const order of orders) {
      const poLines = extractPoLines(order);
      const reg = buildDispatchRegister({ order, poLines, dispatchLines: dispatchByOrder.get(order.id) || [] });
      const schedByIndex = new Map();
      for (const s of (scheduleByOrder.get(order.id) || [])) {
        if (s.line_index != null && s.scheduled_date) schedByIndex.set(String(s.line_index), s.scheduled_date);
      }

      reg.lines.forEach((rl, i) => {
        // Pending only: skip a line that is fully (or over-) dispatched.
        if (rl.balance_qty != null && rl.balance_qty <= 0) return;

        const raw = poLines[i] || {};
        // Split description|part from the Tally munge when the part cell is empty
        // or the description carries the code.
        const split = splitTallyPartDescription(rl.description || rl.part_no || "");
        const part_no = rl.part_no || split.part_no;
        const description = split.part_no ? split.description : (rl.description || split.description);
        const origin_marker = split.origin_marker;

        const supply = resolveSupply(order.id, part_no);
        const origin = classifyOrigin({ part_no, description, origin_marker, source_po_ref: supply.source_po?.reference });

        const ship = supply.shipment;
        const isImport = origin.origin === "import";
        const ready_date = dateOnly(ship?.ready_date) || dateOnly(supply.spoLine?.acknowledged_eta) || dateOnly(supply.source_po?.acknowledged_eta);
        const rate = num(rawField(raw, RATE_KEYS));
        const ordered = rl.ordered_qty;
        const days = daysSince(order.po_date);

        rows.push({
          order_id: order.id,
          so_number: order.po_number || null,
          po_date: dateOnly(order.po_date),
          order_status: order.status,

          description: description || null,
          part_no: part_no || null,
          drawing_no: rawField(raw, DRAWING_KEYS),
          part_split: !!(split.part_no && !rl.part_no),

          ordered_qty: ordered,
          supplied_qty: rl.dispatched_qty,
          balance_qty: rl.balance_qty,
          uom: rl.uom || null,
          rate,
          value: rate != null && ordered != null ? Math.round(rate * ordered * 100) / 100 : null,

          promised_date: schedByIndex.get(String(i)) ? dateOnly(schedByIndex.get(String(i))) : dateOnly(order.committed_delivery_date),
          promised_source: schedByIndex.get(String(i)) ? "schedule_line" : (order.committed_delivery_date ? "order" : null),

          // Supply chain
          source_po_no: supply.source_po?.reference || null,
          origin: origin.origin,
          source_kind: origin.source_kind,
          country: origin.country,
          source_country: origin.source_country,
          origin_confidence: origin.confidence,
          origin_conflict: origin.conflict,
          ready_date,

          // In-transit ladder (import branch only)
          mode: isImport ? (ship?.mode || null) : null,
          shipper_invoice_no: isImport ? (ship?.shipper_invoice_no || null) : null,
          port_of_discharge: isImport ? (ship?.port_of_discharge || null) : null,
          vessel_or_flight: isImport ? (ship?.vessel_or_flight || null) : null,
          vessel_sailing_date: isImport ? dateOnly(ship?.vessel_sailing_date) : null,
          port_arrival_date: isImport ? dateOnly(ship?.port_arrival_date) : null,
          warehouse_receipt_date: isImport ? (dateOnly(supply.shipLine?.receipt_date) || dateOnly(ship?.warehouse_receipt_date)) : null,
          shipment_status: isImport ? (ship?.status || null) : null,

          // Aging
          days_from_po: days,
          over_90_days: days != null && days >= 90,
        });
      });
    }

    return json(res, 200, { customer: customer || null, rows });
  } catch (err) {
    sendError(res, err);
  }
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
