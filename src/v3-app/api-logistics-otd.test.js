// Unit tests for the OTD rollup math (Logistics Ops P3).
import { describe, it, expect } from "vitest";
import { computeOtd } from "../api/_lib/logistics/otd.js";

describe("computeOtd", () => {
  it("counts on-time vs late over committed+delivered orders", () => {
    const orders = [
      { id: "o1", committed_delivery_date: "2026-06-10" },
      { id: "o2", committed_delivery_date: "2026-06-10" },
      { id: "o3", committed_delivery_date: "2026-06-10" }, // committed, not delivered
      { id: "o4", committed_delivery_date: null },          // no commitment -> ignored
    ];
    const shipments = [
      { order_id: "o1", status: "DELIVERED", customer_delivery_date: "2026-06-09" }, // on time
      { order_id: "o2", status: "POD_RECEIVED", customer_delivery_date: "2026-06-14" }, // late
      { order_id: "o4", status: "DELIVERED", customer_delivery_date: "2026-06-01" }, // ignored (no commitment)
    ];
    const r = computeOtd(orders, shipments);
    expect(r).toEqual({ total_delivered: 2, on_time: 1, late: 1, open_committed: 1, otd_pct: 50 });
  });

  it("uses the LATEST delivery date across an order's shipments", () => {
    const orders = [{ id: "o1", committed_delivery_date: "2026-06-10" }];
    const shipments = [
      { order_id: "o1", status: "DELIVERED", customer_delivery_date: "2026-06-08" },
      { order_id: "o1", status: "DELIVERED", customer_delivery_date: "2026-06-12" }, // latest -> late
    ];
    expect(computeOtd(orders, shipments)).toMatchObject({ total_delivered: 1, on_time: 0, late: 1 });
  });

  it("ignores non-delivered shipments and returns null pct when nothing settled", () => {
    const orders = [{ id: "o1", committed_delivery_date: "2026-06-10" }];
    const shipments = [{ order_id: "o1", status: "IN_TRANSIT", customer_delivery_date: null }];
    expect(computeOtd(orders, shipments)).toEqual({ total_delivered: 0, on_time: 0, late: 0, open_committed: 1, otd_pct: null });
  });
});
