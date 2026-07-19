// refreshPositions: proves ERP on-hand actually flows from the mirror
// tables into inventory_positions after the column-mapping fix. Before
// the fix the reader selected columns that do not exist (item_id /
// available_physical / material_no / ...), so structured-ERP on-hand
// was always 0 (or crashed the refresh). In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {} }));

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => svc }));

const svc = {
  from(table) {
    const q = {
      _op: "select", _f: [], _payload: null,
      select() { this._op = "select"; return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      upsert(p) { this._op = "upsert"; this._payload = p; return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      _match(r) { return this._f.every((fn) => fn(r)); },
      _exec() {
        if (this._op === "insert" || this._op === "upsert") {
          H.store[table] = H.store[table] || [];
          const items = Array.isArray(this._payload) ? this._payload : [this._payload];
          H.store[table].push(...items);
          return Promise.resolve({ data: null, error: null });
        }
        // select: a table absent from the store models "relation does
        // not exist" (an un-synced connector on this deployment).
        if (!(table in H.store)) {
          return Promise.resolve({ data: null, error: { message: `relation "${table}" does not exist`, code: "42P01" } });
        }
        return Promise.resolve({ data: H.store[table].filter((r) => this._match(r)), error: null });
      },
      then(res, rej) { return this._exec().then(res, rej); },
    };
    return q;
  },
};

const { refreshPositions, ERP_SOURCES } = await import("../api/_lib/inventory/positions.js");

const future = "2099-01-01";

beforeEach(() => {
  H.store = {
    item_master: [
      { tenant_id: "t-1", part_no: "BEARING-6204", planning_enabled: true, inventory_authoritative_source: null, reorder_point: 10, safety_stock: 5 },
      { tenant_id: "t-1", part_no: "GEAR-88", planning_enabled: true, inventory_authoritative_source: null, reorder_point: 20, safety_stock: 8 },
      { tenant_id: "t-1", part_no: "WIDGET-1", planning_enabled: false, inventory_authoritative_source: null, reorder_point: 0, safety_stock: 0 },
    ],
    // d365 keys on product_external_id + quantity_on_hand.
    d365_inventory_balances: [
      { tenant_id: "t-1", product_external_id: "BEARING-6204", quantity_on_hand: 100, quantity_available: 40 },
    ],
    // sap keys on material_external_id + quantity_on_hand. quantity_unrestricted
    // is mis-populated by the sync (holds a UoM), so reading it would be wrong.
    sap_inventory_balances: [
      { tenant_id: "t-1", material_external_id: "GEAR-88", quantity_on_hand: 250, quantity_unrestricted: 999 },
    ],
    source_po_lines: [
      { tenant_id: "t-1", part_no: "GEAR-88", qty: 60, received_qty: 10 }, // 50 open in-transit
    ],
    inventory_allocations: [
      { tenant_id: "t-1", part_no: "BEARING-6204", qty: 30, status: "reserved", required_by: future },
    ],
    // Other ERP mirror tables are absent -> readSource returns empty.
    inventory_positions: [],
    inventory_exceptions: [],
  };
});

const rowsFor = (part, source) =>
  H.store.inventory_positions.filter((r) => r.part_no === part && r.source === source);

describe("refreshPositions ERP column mapping", () => {
  it("maps d365 (product_external_id/quantity_on_hand) on-hand into positions", async () => {
    const out = await refreshPositions(svc, "t-1", "2026-07-19");
    expect(out.items_updated).toBe(2);       // WIDGET-1 excluded (planning off)
    expect(out.sources_read).toBe(ERP_SOURCES.length);

    // per-source d365 row + the union row both carry the on-hand.
    expect(rowsFor("BEARING-6204", "d365")[0]?.on_hand_qty).toBe(100);
    const union = rowsFor("BEARING-6204", "union")[0];
    expect(union.on_hand_qty).toBe(100);
    expect(union.allocated_qty).toBe(30);    // reserved allocation
    expect(union.in_transit_qty).toBe(0);
  });

  it("reads sap quantity_on_hand (250), not the mis-populated quantity_unrestricted (999)", async () => {
    await refreshPositions(svc, "t-1", "2026-07-19");
    const union = rowsFor("GEAR-88", "union")[0];
    expect(union.on_hand_qty).toBe(250);
    expect(union.in_transit_qty).toBe(50);   // open source_po_lines
  });

  it("excludes non-planning items", async () => {
    await refreshPositions(svc, "t-1", "2026-07-19");
    expect(H.store.inventory_positions.some((r) => r.part_no === "WIDGET-1")).toBe(false);
  });
});
