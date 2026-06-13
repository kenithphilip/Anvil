// Tests for screens/sales-ops.tsx (Sales Ops cockpit).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend({
    analytics: {
      funnel: vi.fn(async () => ({
        as_of: "2026-06-02",
        totals: { count_in_stage: 10, value_in_stage: 100000, weighted_value_in_stage: 5000 },
        stages: [{ stage: "QUALIFICATION", count_in_stage: 10, value_in_stage: 100000, weighted_value_in_stage: 5000, median_age_days: 4, entered: 5, exited: 1 }],
      })),
      winloss: vi.fn(async () => ({
        kpis: { won: 3, won_value: 500000, win_rate: 60 },
        lost_reasons: [{ label: "Price", count: 2 }],
        rep_efficiency: [{ name: "Asha", quotes_won: 5, win_rate: 70, median_response_minutes: 30 }],
      })),
    },
    forecast: { get: vi.fn(async () => ({ buckets: [{ weighted_amount_inr: 5000, open_amount_inr: 100000, next_30_days_amount_inr: 20000 }] })) },
  });
  installRbac("sales_manager");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
});

describe("Sales Ops Cockpit", () => {
  it("renders without throwing", async () => {
    const mod = await import("./sales-ops");
    expect(typeof mod.default).toBe("function");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("wires funnel, win/loss and forecast into one view", async () => {
    const mod = await import("./sales-ops");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Sales Ops Cockpit");
    expect(html).toContain("Weighted pipeline");
    expect(html).toContain("Qualification");   // funnel stage (prettified)
    expect(html).toContain("Price");           // lost reason
    expect(html).toContain("Asha");            // rep efficiency
    expect(html).toContain("Win rate");
  });
});
