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
import {
  learnSuppliersSlas, businessDaysBetween, delayProbability,
  predictEta, criticalityFor, riskScore,
} from "./predict.js";

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
//
// Optional inputs (industry-standard enhancements):
//   * sourcePosHistory: closed/acked POs from the past N months,
//     used to LEARN per-supplier SLAs (median + 1.5*MAD over
//     business-day sent->ack durations). When supplied, the static
//     DEFAULT_SLAS values are used only as a fallback per supplier.
//   * holidays: array of YYYY-MM-DD strings. Excluded from the
//     business-day elapsed counter so a Friday-evening PO doesn't
//     burn 2 calendar days over the weekend.
//
// New per-flag fields (additive, backward-compatible):
//   * delay_probability: 0..1, logistic on (elapsed/sla,
//     supplier_outlier_rate). At ratio=1 (at-SLA), p~0.5; at
//     ratio=2, p~0.88.
//   * eta_predicted: ISO date predicting when this item will
//     likely complete (sent_at + median historical duration).
//   * criticality: 1.0 standalone, 1.25 if a downstream dep is
//     present, 1.5 if both downstream artifacts are present.
//   * risk_score: 0..100, sortable scalar combining probability
//     + criticality.
//   * sla_source: "default" | "learned" so the operator knows
//     whether the SLA came from history or the static fallback.
const scan = ({ sourcePos, internalSos, shipments, slas, sourcePosHistory, holidays }) => {
  const delays = [];
  const sla = { ...DEFAULT_SLAS, ...(slas || {}) };
  const holidaySet = Array.isArray(holidays) ? holidays : [];
  const learnedSlas = learnSuppliersSlas(sourcePosHistory || [], holidaySet);

  // Track which source PO ids have a shipment with a ready_date,
  // for the ready_date_orphan rule below.
  const sourceWithShipment = new Set();
  (shipments || []).forEach((sh) => {
    if (sh.source_po_id && sh.ready_date) sourceWithShipment.add(sh.source_po_id);
  });

  // Workorder downstream deps (for criticality multiplier).
  const downstream = { workOrders: internalSos || [], shipments: shipments || [] };

  (sourcePos || []).forEach((p) => {
    const foreign = isForeign(p.country);
    // Prefer business-day elapsed when sent_at is on the row;
    // fall back to calendar-day elapsed on the broader timestamp.
    const sentAt = p.sent_at || p.updated_at || p.created_at;
    const bdElapsed = businessDaysBetween(sentAt, new Date().toISOString(), holidaySet);
    const elapsed = bdElapsed != null ? bdElapsed : daysSince(p.updated_at || p.created_at);
    const ack = p.status === "SUPPLIER_ACK" || p.status === "ETA_CONFIRMED" || p.status === "RECEIVED" || p.status === "CLOSED";
    const sentNotAck = p.status === "SENT_TO_SUPPLIER" || p.status === "DELAYED";

    // Per-supplier learned stats (or null if no history).
    const supplierStats = (p.supplier && learnedSlas[p.supplier]) || null;
    const criticality = criticalityFor(p.id, downstream);

    // Rule 1 / 2: PO sent but not acknowledged inside its SLA.
    if (sentNotAck && elapsed != null) {
      const kind = foreign ? "po_source_country" : "po_local_supplier";
      // Adaptive SLA: prefer the supplier's learned SLA when at
      // least 5 historical samples are present; else default.
      const slaDays = supplierStats ? supplierStats.sla : sla[kind];
      const slaSource = supplierStats ? "learned" : "default";
      if (elapsed >= slaDays) {
        const dp = delayProbability(elapsed, slaDays);
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
          sla_source: slaSource,
          supplier_samples: supplierStats ? supplierStats.samples : 0,
          delay_probability: dp,
          eta_predicted: predictEta(sentAt, supplierStats, slaDays, holidaySet),
          criticality,
          risk_score: riskScore({ elapsed, sla: slaDays, criticality }),
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
          delay_probability: delayProbability(ackElapsed, sla.ready_date_wait),
          criticality,
          risk_score: riskScore({ elapsed: ackElapsed, sla: sla.ready_date_wait, criticality }),
          detail:
            "Supplier " + (p.supplier || "(unknown)")
            + " acknowledged " + ackElapsed + "d ago but no ready_date / ETA on file",
        });
      }
    }

    // Rule 5: ETA acknowledged but no shipment row references it.
    if (ack && p.acknowledged_eta && !sourceWithShipment.has(p.id)) {
      const etaElapsed = daysSince(p.updated_at);
      // Severity bumps to high when downstream criticality > 1
      // (a work order or shipment is already lined up; the orphan
      // ETA blocks them).
      const sev = criticality > 1.25 ? "high" : criticality > 1 ? "medium" : "medium";
      delays.push({
        kind: "ready_date_orphan",
        severity: sev,
        ref_type: "source_po",
        ref_id: p.id,
        ref_label: p.reference || ("SPO-" + String(p.id).slice(0, 8)),
        supplier: p.supplier || null,
        country: p.country || null,
        customer_id: null,
        order_id: p.order_id || null,
        elapsed_days: etaElapsed,
        sla_days: 0,
        delay_probability: criticality > 1 ? 0.8 : 0.4,
        criticality,
        risk_score: Math.min(100, Math.round((criticality > 1 ? 60 : 35) * criticality)),
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
    const bdEl = businessDaysBetween(ref, new Date().toISOString(), holidaySet);
    const elapsed = bdEl != null ? bdEl : daysSince(ref);
    if (elapsed == null || elapsed < sla.work_order_manufacturing) return;
    // Internal work orders aren't supplier-keyed, so no learned SLA;
    // criticality multiplier still applies if a shipment depends on
    // the underlying source PO chain.
    const wCrit = criticalityFor(iso.id, downstream);
    const dp = delayProbability(elapsed, sla.work_order_manufacturing);
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
      sla_source: "default",
      delay_probability: dp,
      eta_predicted: predictEta(ref, null, sla.work_order_manufacturing, holidaySet),
      criticality: wCrit,
      risk_score: riskScore({ elapsed, sla: sla.work_order_manufacturing, criticality: wCrit }),
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

    // History window: 180 days back of CLOSED / RECEIVED source POs to
    // learn per-supplier SLAs from the actual sent->ack durations.
    const histSince = new Date(Date.now() - 180 * 86400000).toISOString();

    const [poRes, isoRes, shRes, histRes, settingsRes] = await Promise.all([
      svc.from("source_pos")
         .select("id, order_id, reference, supplier, country, status, acknowledged_eta, sent_at, created_at, updated_at")
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
      svc.from("source_pos")
         .select("id, supplier, status, sent_at, acked_at, created_at, updated_at")
         .eq("tenant_id", ctx.tenantId)
         .in("status", ["SUPPLIER_ACK", "ETA_CONFIRMED", "RECEIVED", "CLOSED"])
         .gte("updated_at", histSince)
         .limit(2000),
      svc.from("tenant_settings")
         .select("delay_slas, holidays")
         .eq("tenant_id", ctx.tenantId)
         .maybeSingle(),
    ]);

    if (poRes.error) throw new Error(poRes.error.message);
    if (isoRes.error) throw new Error(isoRes.error.message);
    if (shRes.error) throw new Error(shRes.error.message);
    // History + settings are best-effort. Missing tenant_settings or
    // an absent acked_at column shouldn't sink the live scan.
    const sourcePosHistory = histRes && !histRes.error ? (histRes.data || []) : [];
    const tenantSlas = settingsRes && settingsRes.data ? settingsRes.data.delay_slas || null : null;
    const tenantHolidays = settingsRes && settingsRes.data ? settingsRes.data.holidays || [] : [];

    const out = scan({
      sourcePos: poRes.data || [],
      internalSos: isoRes.data || [],
      shipments: shRes.data || [],
      slas: tenantSlas,
      sourcePosHistory,
      holidays: tenantHolidays,
    });

    return json(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
}

// Test-only export: lets unit tests exercise the rule logic with
// in-memory fixtures, no Supabase round-trips.
export const __test = { scan, isForeign, daysSince, sevFor, DEFAULT_SLAS };
export { scan };
