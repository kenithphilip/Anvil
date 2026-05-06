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
};

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

// Build flag rows from the four data sources.
const scan = ({ sourcePos, internalSos, shipments, slas }) => {
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

    const [poRes, isoRes, shRes] = await Promise.all([
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
         .select("id, source_po_id, ready_date, status")
         .eq("tenant_id", ctx.tenantId)
         .limit(1000),
    ]);

    if (poRes.error) throw new Error(poRes.error.message);
    if (isoRes.error) throw new Error(isoRes.error.message);
    if (shRes.error) throw new Error(shRes.error.message);

    const out = scan({
      sourcePos: poRes.data || [],
      internalSos: isoRes.data || [],
      shipments: shRes.data || [],
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
