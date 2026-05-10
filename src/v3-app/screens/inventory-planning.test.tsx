// Smoke tests for the inventory-planning screens (Phase 3).
//
// One renders-without-throwing assertion per screen plus a couple
// of interaction checks. Heavy data-flow logic lives in the engine
// library and is covered by lib/inventory-engine.test.js.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend({
    inventory: {
      positions: async () => ({ positions: [
        { id: "p1", part_no: "ATD-STD-1", as_of: "2026-05-08", on_hand_qty: 18, in_transit_qty: 8, allocated_qty: 12, net_available_qty: 14, reorder_point: 22, safety_stock: 9, source: "union" },
      ] }),
      forecasts: async () => ({ forecasts: [
        { id: "f1", part_no: "ATD-STD-1", week_start: "2026-05-04", forecast_committed: 2, forecast_pipeline: 3, forecast_baseline: 1, forecast_total: 6, model_name: "TSB", wape_8w: 0.18 },
      ] }),
      plans: {
        list: async () => ({ plans: [
          { id: "pl1", part_no: "ATD-STD-1", recommended_qty: 14, recommended_order_date: "2026-05-15", expected_arrival_date: "2026-08-12", status: "draft", policy_source: "rule_based_coverage", net_requirement: 6, for_week: "2026-07-06", rationale: { lead_time_weeks: 10, coverage_weeks: 12, service_level: 0.99, eoq_candidates: { wilson: 12, coverage: 14 }, top_opps: [] } },
        ] }),
        approve: async () => ({}), release: async () => ({}), cancel: async () => ({}), explain: async () => ({ explanation: "Sample explanation." }),
      },
      exceptions: {
        list: async () => ({ exceptions: [
          { id: "e1", part_no: "ATD-STD-1", exception_kind: "below_reorder_point", severity: "warn", detail: { rop: 22, on_hand: 18 }, status: "open", created_at: new Date().toISOString() },
        ] }),
        ack: async () => ({}), resolve: async () => ({}), suppress: async () => ({}),
      },
      allocations: {
        list: async () => ({ allocations: [
          { id: "a1", part_no: "ATD-STD-1", qty: 2, required_by: "2026-06-15", status: "reserved", project_id: null, order_id: null },
        ] }),
        update: async () => ({}),
      },
      replan: async () => ({ ok: true, result: { items_planned: 4, plans_created: 1 } }),
    },
  });
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("prompt", () => "test note");
});

describe("InventoryPlanningScreen (S1)", () => {
  it("renders dashboard with KPI strip", async () => {
    const mod = await import("./inventory-planning");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Inventory Planning");
    expect(html).toContain("Items at risk");
    expect(html).toContain("Plans pending");
  });
});

describe("InventoryPlansScreen (S2)", () => {
  it("renders the plans queue", async () => {
    const mod = await import("./inventory-plans");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Planned POs");
    expect(container.innerHTML).toContain("ATD-STD-1");
  });
});

describe("InventoryExceptionsScreen (S3)", () => {
  it("renders the exceptions feed", async () => {
    const mod = await import("./inventory-exceptions");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Stock Exceptions");
    expect(container.innerHTML).toContain("below reorder point");
  });
});

describe("InventoryItemDrilldown (S4)", () => {
  it("renders without crashing when no part_no in URL", async () => {
    const original = window.location.hash;
    window.location.hash = "#/inventory-item";
    try {
      const mod = await import("./inventory-item");
      const { container } = renderScreen(mod.default);
      await new Promise((r) => setTimeout(r, 0));
      expect(container.innerHTML).toContain("No part_no");
    } finally { window.location.hash = original; }
  });

  it("renders the position table when part_no is set", async () => {
    const original = window.location.hash;
    window.location.hash = "#/inventory-item?part_no=ATD-STD-1";
    try {
      const mod = await import("./inventory-item");
      const { container } = renderScreen(mod.default);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(container.innerHTML).toContain("ATD-STD-1");
    } finally { window.location.hash = original; }
  });
});

describe("InventoryAllocationsScreen (S5)", () => {
  it("renders the allocations table", async () => {
    const mod = await import("./inventory-allocations");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Allocations");
    expect(container.innerHTML).toContain("Reserved");
  });
});

describe("InventorySuppliersScreen (S6)", () => {
  it("renders without crashing (Phase 3.5 follow-up message)", async () => {
    const mod = await import("./inventory-suppliers");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Suppliers");
  });
});
