// Unit tests for the delay-detection rule library. Each test seeds
// a minimal in-memory dataset (source POs, internal SOs, shipments)
// and asserts which delay flags fire / don't fire. No Supabase
// client; uses the __test export.

import { describe, it, expect } from "vitest";
import { __test } from "../api/delays/scan.js";

const { scan, isForeign, sevFor, daysSince, DEFAULT_SLAS } = __test;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe("delays helpers", () => {
  it("isForeign treats IN/India/blank as local; everything else as foreign", () => {
    expect(isForeign("IN")).toBe(false);
    expect(isForeign("India")).toBe(false);
    expect(isForeign("")).toBe(false);
    expect(isForeign(null)).toBe(false);
    expect(isForeign("DE")).toBe(true);
    expect(isForeign("Germany")).toBe(true);
    expect(isForeign("JP")).toBe(true);
  });

  it("sevFor uses 2x SLA threshold for high", () => {
    expect(sevFor(20, 7)).toBe("high");
    expect(sevFor(10, 7)).toBe("medium");
    expect(sevFor(3, 7)).toBe("low");
    expect(sevFor(null, 7)).toBe("low");
  });

  it("DEFAULT_SLAS has all four families", () => {
    expect(DEFAULT_SLAS.po_source_country).toBeGreaterThan(0);
    expect(DEFAULT_SLAS.po_local_supplier).toBeGreaterThan(0);
    expect(DEFAULT_SLAS.work_order_manufacturing).toBeGreaterThan(0);
    expect(DEFAULT_SLAS.ready_date_wait).toBeGreaterThan(0);
  });
});

describe("rule: po_source_country", () => {
  it("fires when foreign supplier PO sent > 14d ago without ack", () => {
    const out = scan({
      sourcePos: [{
        id: "p1", reference: "SPO-1", supplier: "SKF Germany", country: "DE",
        status: "SENT_TO_SUPPLIER", updated_at: daysAgo(35), // > 2x SLA = high
      }],
      internalSos: [], shipments: [], slas: null,
    });
    expect(out.delays.length).toBe(1);
    expect(out.delays[0].kind).toBe("po_source_country");
    expect(out.delays[0].severity).toBe("high");
  });

  it("does not fire when within SLA", () => {
    const out = scan({
      sourcePos: [{
        id: "p1", reference: "SPO-1", country: "DE",
        status: "SENT_TO_SUPPLIER", updated_at: daysAgo(5),
      }],
      internalSos: [], shipments: [], slas: null,
    });
    expect(out.delays.length).toBe(0);
  });

  it("does not fire when ack'd", () => {
    const out = scan({
      sourcePos: [{
        id: "p1", country: "DE", status: "SUPPLIER_ACK", acknowledged_eta: "2026-06-01",
        updated_at: daysAgo(20),
      }],
      internalSos: [], shipments: [{ source_po_id: "p1", ready_date: "2026-06-01" }],
      slas: null,
    });
    // No source-country flag. (Other rules also don't fire since
    // ack'd + ETA + shipment row present.)
    expect(out.delays.find((d) => d.kind === "po_source_country")).toBeUndefined();
  });
});

describe("rule: po_local_supplier", () => {
  it("fires for domestic supplier sent > 7d ago", () => {
    const out = scan({
      sourcePos: [{
        id: "p2", reference: "SPO-2", supplier: "SKF India", country: "IN",
        status: "SENT_TO_SUPPLIER", updated_at: daysAgo(10),
      }],
      internalSos: [], shipments: [], slas: null,
    });
    expect(out.delays[0]?.kind).toBe("po_local_supplier");
  });
});

describe("rule: work_order_manufacturing", () => {
  it("fires when internal SO approved > 5d ago, still not dispatched", () => {
    const out = scan({
      sourcePos: [],
      internalSos: [{
        id: "i1", iso_number: "ISO-1", status: "APPROVED", approved_at: daysAgo(8),
      }],
      shipments: [], slas: null,
    });
    expect(out.delays[0]?.kind).toBe("work_order_manufacturing");
  });

  it("does not fire when status is DISPATCHED", () => {
    const out = scan({
      sourcePos: [],
      internalSos: [{
        id: "i1", iso_number: "ISO-1", status: "DISPATCHED", approved_at: daysAgo(8),
      }],
      shipments: [], slas: null,
    });
    expect(out.delays.find((d) => d.kind === "work_order_manufacturing")).toBeUndefined();
  });
});

describe("rule: ready_date_missing", () => {
  it("fires when ack'd but no acknowledged_eta after 7d", () => {
    const out = scan({
      sourcePos: [{
        id: "p3", supplier: "ABB", status: "SUPPLIER_ACK", acknowledged_eta: null,
        updated_at: daysAgo(10),
      }],
      internalSos: [], shipments: [], slas: null,
    });
    expect(out.delays.find((d) => d.kind === "ready_date_missing")).toBeTruthy();
  });

  it("does not fire when acknowledged_eta is present", () => {
    const out = scan({
      sourcePos: [{
        id: "p3", supplier: "ABB", status: "SUPPLIER_ACK", acknowledged_eta: "2026-07-01",
        updated_at: daysAgo(10),
      }],
      internalSos: [], shipments: [{ source_po_id: "p3", ready_date: "2026-07-01" }],
      slas: null,
    });
    expect(out.delays.find((d) => d.kind === "ready_date_missing")).toBeUndefined();
  });
});

describe("rule: ready_date_orphan", () => {
  it("fires when ETA on file but no shipment references it", () => {
    const out = scan({
      sourcePos: [{
        id: "p4", supplier: "Bosch", status: "ETA_CONFIRMED",
        acknowledged_eta: "2026-08-01", updated_at: daysAgo(3),
      }],
      internalSos: [],
      shipments: [], // no shipment row pointing at p4
      slas: null,
    });
    expect(out.delays.find((d) => d.kind === "ready_date_orphan")).toBeTruthy();
  });

  it("does not fire when a shipment row picks up the ready date", () => {
    const out = scan({
      sourcePos: [{
        id: "p4", supplier: "Bosch", status: "ETA_CONFIRMED",
        acknowledged_eta: "2026-08-01", updated_at: daysAgo(3),
      }],
      internalSos: [],
      shipments: [{ source_po_id: "p4", ready_date: "2026-08-01" }],
      slas: null,
    });
    expect(out.delays.find((d) => d.kind === "ready_date_orphan")).toBeUndefined();
  });
});

describe("scan summary", () => {
  it("returns total + per-kind counts and sorts by severity", () => {
    const out = scan({
      sourcePos: [
        { id: "p1", country: "DE", status: "SENT_TO_SUPPLIER", updated_at: daysAgo(35) },  // high
        { id: "p2", country: "IN", status: "SENT_TO_SUPPLIER", updated_at: daysAgo(10) },  // medium
      ],
      internalSos: [
        { id: "i1", iso_number: "ISO-1", status: "APPROVED", approved_at: daysAgo(11) },  // high (>2x sla 5)
      ],
      shipments: [], slas: null,
    });
    expect(out.summary.total).toBe(3);
    expect(out.summary.byKind.po_source_country).toBe(1);
    expect(out.summary.byKind.po_local_supplier).toBe(1);
    expect(out.summary.byKind.work_order_manufacturing).toBe(1);
    expect(out.delays[0].severity).toBe("high");
  });
});

describe("outbound (customer-facing) rules", () => {
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const agoDays = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  it("flags dispatch_overdue: approved order, no shipment, past SLA", () => {
    const out = scan({
      orders: [{ id: "o1", po_number: "PO-1", status: "APPROVED", updated_at: daysAgo(5) }],
      shipments: [], slas: null,
    });
    const f = out.delays.find((d) => d.kind === "dispatch_overdue");
    expect(f).toBeTruthy();
    expect(f.ref_type).toBe("order");
    expect(f.order_id).toBe("o1");
  });

  it("does NOT flag dispatch_overdue once a shipment exists for the order", () => {
    const out = scan({
      orders: [{ id: "o1", status: "APPROVED", updated_at: daysAgo(5) }],
      shipments: [{ id: "s1", order_id: "o1", status: "PLANNED" }], slas: null,
    });
    expect(out.delays.find((d) => d.kind === "dispatch_overdue")).toBeUndefined();
  });

  it("flags customer_delivery_overdue when committed date passed and not delivered", () => {
    const out = scan({
      orders: [{ id: "o1", po_number: "PO-1", status: "EXPORTED_TO_TALLY", committed_delivery_date: agoDays(4) }],
      shipments: [{ id: "s1", order_id: "o1", status: "IN_TRANSIT" }], slas: null,
    });
    const f = out.delays.find((d) => d.kind === "customer_delivery_overdue");
    expect(f).toBeTruthy();
    expect(f.severity).toBe("high");     // 4d overdue >= dispatch_overdue(3)
    expect(f.elapsed_days).toBe(4);
  });

  it("flags customer_delivery_at_risk inside the risk window", () => {
    const out = scan({
      orders: [{ id: "o1", status: "APPROVED", committed_delivery_date: inDays(2) }],
      shipments: [{ id: "s1", order_id: "o1", status: "PLANNED" }], slas: null,
    });
    const f = out.delays.find((d) => d.kind === "customer_delivery_at_risk");
    expect(f).toBeTruthy();
    expect(f.severity).toBe("medium");   // 2 days out
  });

  it("does NOT flag delivery rules once the order has a dated DELIVERED shipment", () => {
    const out = scan({
      orders: [{ id: "o1", status: "APPROVED", committed_delivery_date: agoDays(4) }],
      shipments: [{ id: "s1", order_id: "o1", status: "DELIVERED", customer_delivery_date: agoDays(1) }], slas: null,
    });
    expect(out.delays.find((d) => d.kind.startsWith("customer_delivery"))).toBeUndefined();
  });

  it("STILL flags overdue when a DELIVERED shipment has no delivery date (consistent with OTD)", () => {
    // A dateless DELIVERED shipment must not silently suppress the overdue flag
    // AND escape the OTD denominator — the two subsystems agree on "delivered".
    const out = scan({
      orders: [{ id: "o1", status: "FAILED_TALLY_IMPORT", committed_delivery_date: agoDays(4) }],
      shipments: [{ id: "s1", order_id: "o1", status: "DELIVERED", customer_delivery_date: null }], slas: null,
    });
    expect(out.delays.find((d) => d.kind === "customer_delivery_overdue")).toBeTruthy();
  });

  it("does NOT flag at_risk/overdue for orders with no commitment", () => {
    const out = scan({
      orders: [{ id: "o1", status: "APPROVED", committed_delivery_date: null, updated_at: daysAgo(1) }],
      shipments: [{ id: "s1", order_id: "o1", status: "PLANNED" }], slas: null,
    });
    expect(out.delays.find((d) => d.kind.startsWith("customer_delivery"))).toBeUndefined();
  });
});
