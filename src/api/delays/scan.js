// POST /api/delays/scan
//
// Foolproof lag/delay detector. Scans every in-flight purchase
// order, internal work order, and shipment plan, and flags items
// whose downstream realisation is overdue or missing. Five rule
// families, each with honest defaults and graceful degradation:
//
//   1. po_source_country         Source-country (foreign) PO sent
//                                to supplier > N days ago without
//                                acknowledgement / ETA / receipt.
//   2. po_local_supplier         Domestic-supplier PO sent without
//                                acknowledgement / ETA / receipt
//                                inside its (tighter) SLA.
//   3. work_order_manufacturing  Internal SO approved but not
//                                dispatched to mfg inside SLA.
//   4. ready_date_missing        Source PO acknowledged but no
//                                ready_date / ETA recorded.
//   5. ready_date_orphan         Source PO has an acknowledged
//                                ETA but no shipment row references
//                                it (the ready date "got lost").
//
// Outbound (customer-facing) families (P3), driven by `orders`:
//   6. dispatch_overdue          Order approved/ready to ship but no
//                                shipment booked inside SLA.
//   7. customer_delivery_overdue Committed delivery date passed with
//                                no delivered shipment.
//   8. customer_delivery_at_risk Committed date approaching (within
//                                the risk window), not yet delivered.
//
// SLA defaults are honest: PO source-country = 14d, PO local = 7d,
// work order = 5d, ready-date wait = 7d. Each rule emits a flag
// with severity (high if past 2x SLA), elapsed_days, and a clear
// detail string the operator can act on.
//
// Returns: { delays: [...], summary: { total, byKind } }

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// SLA defaults (days). Tenants will eventually override via
// tenant_settings.delay_slas; until that lands, these are the
// playbook defaults common in industrial-distributor sales-ops.
const DEFAULT_SLAS = {
  po_source_country: 14,        // foreign supplier ack window
  po_local_supplier: 7,         // domestic supplier ack window
  work_order_manufacturing: 5,  // approved -> dispatched
  ready_date_wait: 7,           // ack -> ready_date populated
  // Outbound (customer-facing) SLAs (P3).
  dispatch_overdue: 3,          // order ready-to-ship -> shipment booked
  delivery_risk_window: 3,      // days before committed date to warn "at risk"
};

// Order statuses that are past-approval and expected to ship.
const READY_TO_SHIP = new Set(["APPROVED", "EXPORTED_TO_TALLY", "RECONCILED"]);

// Rough domestic vs foreign classifier. country is free-text on
// source_pos.country; treat IN / India / blank as local. Anything
// else is foreign.
const isForeign = (country) => {
  if (!country) return false;
  const c = String(country).trim().toUpperCase();
  return !(c === "IN" || c === "INDIA" || c === "");
};

const daysSince = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

const sevFor = (elapsed, sla) => {
  if (elapsed == null) return "low";
  if (elapsed >= sla * 2) return "high";
  if (elapsed >= sla) return "medium";
  return "low";
};

// Build flag rows from the four data sources. Exported so the persistent,
// config-driven logistics monitor (_lib/logistics/monitor.js) can reuse the
// exact same rule logic instead of duplicating it.
export const scan = ({ sourcePos, internalSos, shipments, orders, slas }) => {
  const delays = [];
  const sla = { ...DEFAULT_SLAS, ...(slas || {}) };

  // Track which source PO ids have a shipment with a ready_date,
  // for the ready_date_orphan rule below.
  const sourceWithShipment = new Set();
  (shipments || []).forEach((sh) => {
    if (sh.source_po_id && sh.ready_date) sourceWithShipment.add(sh.source_po_id);
  });

  (sourcePos || []).forEach((p) => {
    const foreign = isForeign(p.country);
    const elapsed = daysSince(p.updated_at || p.created_at);
    const ack = p.status === "SUPPLIER_ACK" || p.status === "ETA_CONFIRMED" || p.status === "RECEIVED" || p.status === "CLOSED";
    const sentNotAck = p.status === "SENT_TO_SUPPLIER" || p.status === "DELAYED";

    // Rule 1 / 2: PO sent but not acknowledged inside its SLA.
    if (sentNotAck && elapsed != null) {
      const kind = foreign ? "po_source_country" : "po_local_supplier";
      const slaDays = sla[kind];
      if (elapsed >= slaDays) {
        delays.push({
          kind,
          severity: sevFor(elapsed, slaDays),
          ref_type: "source_po",
          ref_id: p.id,
          ref_label: p.reference || ("SPO-" + String(p.id).slice(0, 8)),
          supplier: p.supplier || null,
          country: p.country || null,
          customer_id: null,
          order_id: p.order_id || null,
          elapsed_days: elapsed,
          sla_days: slaDays,
          detail:
            (foreign ? "Foreign-supplier" : "Local-supplier")
            + " PO " + (p.reference || p.id)
            + " sent " + elapsed + "d ago, no acknowledgement (SLA " + slaDays + "d)",
        });
      }
    }

    // Rule 4: PO acknowledged but no ready_date / acknowledged_eta.
    if (ack && !p.acknowledged_eta) {
      // age since updated_at: probably the moment they ACK'd
      const ackElapsed = daysSince(p.updated_at);
      if (ackElapsed != null && ackElapsed >= sla.ready_date_wait) {
        delays.push({
          kind: "ready_date_missing",
          severity: sevFor(ackElapsed, sla.ready_date_wait),
          ref_type: "source_po",
          ref_id: p.id,
          ref_label: p.reference || ("SPO-" + String(p.id).slice(0, 8)),
          supplier: p.supplier || null,
          country: p.country || null,
          customer_id: null,
          order_id: p.order_id || null,
          elapsed_days: ackElapsed,
          sla_days: sla.ready_date_wait,
          detail:
            "Supplier " + (p.supplier || "(unknown)")
            + " acknowledged " + ackElapsed + "d ago but no ready_date / ETA on file",
        });
      }
    }

    // Rule 5: ETA acknowledged but no shipment row references it.
    if (ack && p.acknowledged_eta && !sourceWithShipment.has(p.id)) {
      const etaElapsed = daysSince(p.updated_at);
      // Always flag, low severity; the operator should at least add
      // it to a shipment plan even if shipping is weeks out.
      delays.push({
        kind: "ready_date_orphan",
        severity: "medium",
        ref_type: "source_po",
        ref_id: p.id,
        ref_label: p.reference || ("SPO-" + String(p.id).slice(0, 8)),
        supplier: p.supplier || null,
        country: p.country || null,
        customer_id: null,
        order_id: p.order_id || null,
        elapsed_days: etaElapsed,
        sla_days: 0,
        detail:
          "Supplier ETA " + p.acknowledged_eta
          + " on file but no shipment plan references this source PO",
      });
    }
  });

  // Rule 3: work order to manufacturing approved but not dispatched.
  (internalSos || []).forEach((iso) => {
    if (iso.status !== "APPROVED") return;
    const ref = iso.approved_at || iso.created_at;
    const elapsed = daysSince(ref);
    if (elapsed == null || elapsed < sla.work_order_manufacturing) return;
    delays.push({
      kind: "work_order_manufacturing",
      severity: sevFor(elapsed, sla.work_order_manufacturing),
      ref_type: "internal_so",
      ref_id: iso.id,
      ref_label: iso.iso_number || ("ISO-" + String(iso.id).slice(0, 8)),
      supplier: iso.vendor_name || null,
      country: null,
      customer_id: iso.customer_id || null,
      order_id: null,
      elapsed_days: elapsed,
      sla_days: sla.work_order_manufacturing,
      detail:
        "Work order " + (iso.iso_number || iso.id)
        + " approved " + elapsed + "d ago, still not dispatched to manufacturing"
        + " (SLA " + sla.work_order_manufacturing + "d)",
    });
  });

  // Outbound (customer-facing) rules (P3). Map order coverage from shipments.
  const shippedOrderIds = new Set();
  const deliveredOrderIds = new Set();
  (shipments || []).forEach((sh) => {
    if (!sh.order_id) return;
    shippedOrderIds.add(sh.order_id);
    // "Delivered" requires a delivered status AND a real delivery date -- the
    // same definition computeOtd() uses. A DELIVERED shipment with a null
    // customer_delivery_date keeps flagging overdue (surfacing the missing date)
    // and stays consistently out of the OTD denominator.
    if ((sh.status === "DELIVERED" || sh.status === "POD_RECEIVED")
        && sh.customer_delivery_date && Number.isFinite(Date.parse(sh.customer_delivery_date))) {
      deliveredOrderIds.add(sh.order_id);
    }
  });
  // committed_delivery_date is a DB date (parses to UTC midnight); normalize
  // "today" to UTC midnight too so the day diff is whole days, not off-by-one
  // from the current time of day.
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10));

  (orders || []).forEach((o) => {
    const label = o.po_number || o.reference || ("ORD-" + String(o.id).slice(0, 8));

    // Rule 6: dispatch overdue — order ready to ship, no shipment booked, past SLA.
    if (READY_TO_SHIP.has(o.status) && !shippedOrderIds.has(o.id)) {
      const elapsed = daysSince(o.updated_at || o.created_at);
      if (elapsed != null && elapsed >= sla.dispatch_overdue) {
        delays.push({
          kind: "dispatch_overdue",
          severity: sevFor(elapsed, sla.dispatch_overdue),
          ref_type: "order", ref_id: o.id, ref_label: label,
          supplier: null, country: null, customer_id: o.customer_id || null, order_id: o.id,
          elapsed_days: elapsed, sla_days: sla.dispatch_overdue,
          detail: "Order " + label + " approved " + elapsed + "d ago, no shipment booked (SLA " + sla.dispatch_overdue + "d)",
        });
      }
    }

    // Rules 7 / 8: customer delivery overdue / at risk. Needs a commitment and
    // no delivered shipment yet.
    const committed = o.committed_delivery_date ? Date.parse(o.committed_delivery_date) : null;
    if (committed != null && Number.isFinite(committed) && !deliveredOrderIds.has(o.id)) {
      const daysToCommitted = Math.floor((committed - todayMs) / 86400000);
      if (daysToCommitted < 0) {
        const overdue = -daysToCommitted;
        delays.push({
          kind: "customer_delivery_overdue",
          severity: overdue >= sla.dispatch_overdue ? "high" : "medium",
          ref_type: "order", ref_id: o.id, ref_label: label,
          supplier: null, country: null, customer_id: o.customer_id || null, order_id: o.id,
          elapsed_days: overdue, sla_days: 0,
          detail: "Order " + label + " committed " + o.committed_delivery_date + " is " + overdue + "d overdue, not delivered",
        });
      } else if (daysToCommitted <= sla.delivery_risk_window) {
        delays.push({
          kind: "customer_delivery_at_risk",
          severity: daysToCommitted <= 1 ? "high" : "medium",
          ref_type: "order", ref_id: o.id, ref_label: label,
          supplier: null, country: null, customer_id: o.customer_id || null, order_id: o.id,
          elapsed_days: daysToCommitted, sla_days: sla.delivery_risk_window,
          detail: "Order " + label + " due " + o.committed_delivery_date + " in " + daysToCommitted + "d, no delivered shipment",
        });
      }
    }
  });

  // Sort by severity then elapsed.
  const sevRank = { high: 0, medium: 1, low: 2 };
  delays.sort((a, b) => {
    const dr = sevRank[a.severity] - sevRank[b.severity];
    if (dr !== 0) return dr;
    return (b.elapsed_days || 0) - (a.elapsed_days || 0);
  });

  const byKind = {};
  delays.forEach((d) => { byKind[d.kind] = (byKind[d.kind] || 0) + 1; });

  return { delays, summary: { total: delays.length, byKind } };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST" && req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();

    const [poRes, isoRes, shRes, ordRes] = await Promise.all([
      svc.from("source_pos")
         .select("id, order_id, reference, supplier, country, status, acknowledged_eta, created_at, updated_at")
         .eq("tenant_id", ctx.tenantId)
         .in("status", ["SENT_TO_SUPPLIER", "SUPPLIER_ACK", "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED"])
         .order("updated_at", { ascending: true })
         .limit(500),
      svc.from("internal_sales_orders")
         .select("id, iso_number, status, customer_id, vendor_name, approved_at, created_at")
         .eq("tenant_id", ctx.tenantId)
         .in("status", ["APPROVED", "DISPATCHED"])
         .order("approved_at", { ascending: true })
         .limit(500),
      svc.from("shipments")
         .select("id, source_po_id, order_id, ready_date, customer_delivery_date, status")
         .eq("tenant_id", ctx.tenantId)
         .limit(1000),
      // Outbound: orders in a post-approval state that still owe the customer a
      // delivery (incl. FAILED_TALLY_IMPORT -- an approved order whose export
      // failed still carries a live commitment). Excludes DRAFT/PENDING_REVIEW
      // (pre-commitment) and BLOCKED/CANCELLED/DUPLICATE/REUSED (void/held).
      svc.from("orders")
         .select("id, po_number, customer_id, status, committed_delivery_date, created_at, updated_at")
         .eq("tenant_id", ctx.tenantId)
         .in("status", ["APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED"])
         .order("updated_at", { ascending: true })
         .limit(500),
    ]);

    if (poRes.error) throw new Error(poRes.error.message);
    if (isoRes.error) throw new Error(isoRes.error.message);
    if (shRes.error) throw new Error(shRes.error.message);
    if (ordRes.error) throw new Error(ordRes.error.message);

    const out = scan({
      sourcePos: poRes.data || [],
      internalSos: isoRes.data || [],
      shipments: shRes.data || [],
      orders: ordRes.data || [],
      slas: null,
    });

    return json(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
}

// Test-only export: lets unit tests exercise the rule logic with
// in-memory fixtures, no Supabase round-trips.
export const __test = { scan, isForeign, daysSince, sevFor, DEFAULT_SLAS };
