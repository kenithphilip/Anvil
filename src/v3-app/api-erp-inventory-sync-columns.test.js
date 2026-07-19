// Guards the inventory upsert mappers of the SAP + P21 connectors.
// Both wrote the wrong value into an inventory-balance column:
//   - SAP put MaterialBaseUnit (a UoM code) into quantity_unrestricted.
//   - P21 put qty_allocated into quantity_available (the opposite sense).
// These assert the corrected mappings against a captured upsert payload.

import { describe, it, expect } from "vitest";
import { ENTITY as SAP_ENTITY } from "../api/sap/sync.js";
import { ENTITY as P21_ENTITY } from "../api/p21/sync.js";

// Minimal Supabase stub that captures upsert payloads.
const capture = () => {
  const sink = [];
  const svc = {
    from(table) {
      return { upsert(payload) { sink.push({ table, payload }); return Promise.resolve({ data: null, error: null }); } };
    },
  };
  return { svc, sink };
};

describe("SAP inventory upsert mapping", () => {
  it("captures on-hand and does NOT store the UoM as quantity_unrestricted", async () => {
    const { svc, sink } = capture();
    await SAP_ENTITY.inventory.upsert(svc, "t-1", [
      { Material: "M-1", Plant: "1000", StorageLocation: "0001", MatlWrhsStkQtyInMatlBaseUnit: 42, MaterialBaseUnit: "EA" },
    ]);
    const row = sink[0].payload;
    expect(sink[0].table).toBe("sap_inventory_balances");
    expect(row.quantity_on_hand).toBe(42);
    expect(row.quantity_unrestricted).toBeNull(); // was Number("EA") -> NaN
    expect(row.base_uom).toBe("EA");              // the UoM belongs here
  });

  it("skips rows without a Material", async () => {
    const { svc, sink } = capture();
    await SAP_ENTITY.inventory.upsert(svc, "t-1", [{ Plant: "1000" }]);
    expect(sink.length).toBe(0);
  });
});

describe("P21 inventory upsert mapping", () => {
  it("derives available as on-hand minus allocated", async () => {
    const { svc, sink } = capture();
    await P21_ENTITY.inventory.upsert(svc, "t-1", [
      { item_id: "IT-1", location_id: "W1", qty_on_hand: 100, qty_allocated: 30, base_uom: "EA" },
    ]);
    const row = sink[0].payload;
    expect(sink[0].table).toBe("p21_inventory_balances");
    expect(row.quantity_on_hand).toBe(100);
    expect(row.quantity_available).toBe(70); // 100 - 30, was 30 (allocated)
  });

  it("keeps available signed when over-allocated", async () => {
    const { svc, sink } = capture();
    await P21_ENTITY.inventory.upsert(svc, "t-1", [
      { item_id: "IT-2", location_id: "W1", qty_on_hand: 10, qty_allocated: 25 },
    ]);
    expect(sink[0].payload.quantity_available).toBe(-15);
  });

  it("leaves available null when neither quantity is present", async () => {
    const { svc, sink } = capture();
    await P21_ENTITY.inventory.upsert(svc, "t-1", [
      { item_id: "IT-3", location_id: "W1", base_uom: "EA" },
    ]);
    expect(sink[0].payload.quantity_available).toBeNull();
    expect(sink[0].payload.quantity_on_hand).toBeNull();
  });
});
